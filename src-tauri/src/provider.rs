use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::secrets::inject_secrets;

/// Issues provider requests on behalf of the frontend.
///
/// The frontend assembles the request from its own curl template, but leaves
/// `{{OMNI_SECRET:NAME}}` where a credential belongs. The value is read from the
/// OS credential store here, so a key never crosses the IPC boundary and script
/// running in the webview has nothing to steal.

#[derive(Deserialize)]
pub struct ProviderRequest {
    pub request_id: String,
    pub provider_id: String,
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
}

#[derive(Default)]
pub struct CancelledRequests(Mutex<HashSet<String>>);

impl CancelledRequests {
    fn cancel(&self, request_id: &str) {
        if let Ok(mut set) = self.0.lock() {
            set.insert(request_id.to_string());
        }
    }

    fn is_cancelled(&self, request_id: &str) -> bool {
        self.0
            .lock()
            .map(|set| set.contains(request_id))
            .unwrap_or(false)
    }

    fn forget(&self, request_id: &str) {
        if let Ok(mut set) = self.0.lock() {
            set.remove(request_id);
        }
    }
}

/// Decodes as much of the buffer as forms complete UTF-8, leaving any trailing
/// partial character behind.
///
/// Chunk boundaries fall wherever the network puts them, so a multi-byte
/// character can be split across two chunks. Decoding each chunk independently
/// replaces the halves with replacement characters, which corrupts any response
/// containing an emoji or non-Latin text.
pub fn take_complete_utf8(buffer: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buffer) {
        Ok(text) => {
            let owned = text.to_string();
            buffer.clear();
            owned
        }
        Err(error) => {
            let valid_up_to = error.valid_up_to();
            let text = String::from_utf8_lossy(&buffer[..valid_up_to]).to_string();
            buffer.drain(..valid_up_to);
            text
        }
    }
}

fn build_headers(provider_id: &str, raw: &HashMap<String, String>) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();

    for (name, value) in raw {
        let injected = inject_secrets(provider_id, value)?;
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("Invalid header name: {name}"))?;
        let header_value = HeaderValue::from_str(&injected)
            .map_err(|_| format!("Invalid value for header {name}"))?;
        headers.insert(header_name, header_value);
    }

    Ok(headers)
}

#[tauri::command]
pub async fn provider_request(
    request: ProviderRequest,
    cancelled: State<'_, CancelledRequests>,
    on_chunk: Channel<String>,
) -> Result<(), String> {
    let ProviderRequest {
        request_id,
        provider_id,
        url,
        method,
        headers,
        body,
    } = request;

    let result = send(
        &request_id,
        &provider_id,
        &url,
        &method,
        &headers,
        body.as_deref(),
        &cancelled,
        &on_chunk,
    )
    .await;

    cancelled.forget(&request_id);
    result
}

#[allow(clippy::too_many_arguments)]
async fn send(
    request_id: &str,
    provider_id: &str,
    url: &str,
    method: &str,
    headers: &HashMap<String, String>,
    body: Option<&str>,
    cancelled: &CancelledRequests,
    on_chunk: &Channel<String>,
) -> Result<(), String> {
    let url = inject_secrets(provider_id, url)?;
    let header_map = build_headers(provider_id, headers)?;
    let body = match body {
        Some(raw) => Some(inject_secrets(provider_id, raw)?),
        None => None,
    };

    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| format!("Unsupported method: {method}"))?;

    let client = reqwest::Client::new();
    let mut builder = client.request(method, &url).headers(header_map);
    if let Some(body) = body {
        builder = builder.body(body);
    }

    let response = builder
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", strip_url(&e.to_string(), &url)))?;

    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err(format!(
            "Provider returned {}{}",
            status.as_u16(),
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {}", detail.chars().take(400).collect::<String>())
            }
        ));
    }

    let mut stream = response.bytes_stream();
    let mut pending = Vec::new();

    while let Some(chunk) = stream.next().await {
        if cancelled.is_cancelled(request_id) {
            return Ok(());
        }

        let bytes = chunk.map_err(|e| format!("Stream error: {e}"))?;
        pending.extend_from_slice(&bytes);

        let text = take_complete_utf8(&mut pending);
        if !text.is_empty() {
            on_chunk
                .send(text)
                .map_err(|e| format!("Could not deliver chunk: {e}"))?;
        }
    }

    // A trailing partial character means the stream ended mid-character; emit it
    // lossily rather than dropping content.
    if !pending.is_empty() {
        let tail = String::from_utf8_lossy(&pending).to_string();
        on_chunk
            .send(tail)
            .map_err(|e| format!("Could not deliver chunk: {e}"))?;
    }

    Ok(())
}

/// Errors from reqwest embed the full URL, which can carry a key in a query
/// parameter for providers that authenticate that way.
fn strip_url(message: &str, url: &str) -> String {
    message.replace(url, "the provider endpoint")
}

#[tauri::command]
pub fn provider_request_cancel(request_id: String, cancelled: State<'_, CancelledRequests>) {
    cancelled.cancel(&request_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_utf8_is_taken_whole() {
        let mut buffer = "hello".as_bytes().to_vec();
        assert_eq!(take_complete_utf8(&mut buffer), "hello");
        assert!(buffer.is_empty());
    }

    #[test]
    fn a_split_multibyte_character_is_held_back_until_complete() {
        // Without this a response containing an emoji arrives corrupted.
        let emoji = "🎉".as_bytes().to_vec();
        let (first, second) = emoji.split_at(2);

        let mut buffer = b"ok ".to_vec();
        buffer.extend_from_slice(first);
        assert_eq!(
            take_complete_utf8(&mut buffer),
            "ok ",
            "the partial character must not be emitted"
        );
        assert_eq!(buffer.len(), 2, "its bytes stay buffered");

        buffer.extend_from_slice(second);
        assert_eq!(take_complete_utf8(&mut buffer), "🎉");
        assert!(buffer.is_empty());
    }

    #[test]
    fn multibyte_text_survives_byte_by_byte_delivery() {
        let source = "héllo 🎉 世界";
        let mut buffer = Vec::new();
        let mut assembled = String::new();

        for byte in source.as_bytes() {
            buffer.push(*byte);
            assembled.push_str(&take_complete_utf8(&mut buffer));
        }

        assert_eq!(assembled, source);
        assert!(buffer.is_empty());
    }

    #[test]
    fn cancellation_is_scoped_to_one_request() {
        let state = CancelledRequests::default();
        state.cancel("req_a");
        assert!(state.is_cancelled("req_a"));
        assert!(!state.is_cancelled("req_b"));

        state.forget("req_a");
        assert!(
            !state.is_cancelled("req_a"),
            "a finished request must not leave its id behind, or an id reuse cancels instantly"
        );
    }

    #[test]
    fn an_error_message_does_not_echo_the_url() {
        // Some providers authenticate with a key in the query string.
        let url = "https://api.example.com/v1/chat?key=sk-secret-value";
        let message = format!("error sending request for url ({url})");
        let cleaned = strip_url(&message, url);
        assert!(!cleaned.contains("sk-secret-value"));
        assert!(cleaned.contains("the provider endpoint"));
    }
}
