use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::secrets::{inject_secrets_for, origin_of};

/// Issues provider requests on behalf of the frontend.
///
/// The frontend assembles the request from its own curl template, but leaves
/// `{{OMNI_SECRET:NAME}}` where a credential belongs. The value is read from the
/// OS credential store here, so a key never crosses the IPC boundary and script
/// running in the webview has nothing to steal.

// Field names match what the frontend sends. Tauri converts a command's own
// argument names to snake_case, but a nested struct is plain serde, so this
// rename is what keeps `requestId` from arriving as a missing field.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRequest {
    pub request_id: String,
    pub provider_id: String,
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    pub upload: Option<RequestUpload>,
}

/// Bytes the frontend wants uploaded, base64 so they can cross IPC.
///
/// `field` set means multipart with the bytes in that field; absent means the
/// bytes are the whole body. Multipart is not something the frontend can
/// assemble itself: the body would have to be a String, and audio is not UTF-8.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestUpload {
    pub data_base64: String,
    pub field: Option<String>,
    pub file_name: Option<String>,
    pub mime_type: Option<String>,
    #[serde(default)]
    pub fields: HashMap<String, String>,
}

/// The request body, fully resolved before anything touches the network.
#[derive(Debug)]
pub enum Payload {
    Empty,
    Text(String),
    Binary {
        bytes: Vec<u8>,
    },
    Form {
        bytes: Vec<u8>,
        field: String,
        file_name: String,
        mime_type: String,
        fields: Vec<(String, String)>,
    },
}

/// Decides what the body is and substitutes secrets into every text part of it.
///
/// Separated from `send` so the decision is testable without a network, and so
/// the one rule that matters is visible in isolation: the injector runs over
/// text fields and never over the uploaded bytes.
pub fn resolve_payload<F>(
    body: Option<&str>,
    upload: Option<&RequestUpload>,
    inject: F,
) -> Result<Payload, String>
where
    F: Fn(&str) -> Result<String, String>,
{
    match (body, upload) {
        (Some(_), Some(_)) => {
            Err("A request carries either a body or an upload, not both.".to_string())
        }
        (Some(raw), None) => Ok(Payload::Text(inject(raw)?)),
        (None, None) => Ok(Payload::Empty),
        (None, Some(upload)) => {
            let bytes = BASE64
                .decode(upload.data_base64.as_bytes())
                .map_err(|e| format!("Could not decode the upload: {e}"))?;

            match &upload.field {
                None => Ok(Payload::Binary { bytes }),
                Some(field) => {
                    // Sorted so the same upload produces the same request every
                    // time; HashMap iteration order is not stable.
                    let mut names: Vec<&String> = upload.fields.keys().collect();
                    names.sort();

                    let mut fields = Vec::with_capacity(names.len());
                    for name in names {
                        let value = inject(&upload.fields[name])?;
                        fields.push((name.clone(), value));
                    }

                    Ok(Payload::Form {
                        bytes,
                        field: field.clone(),
                        file_name: upload
                            .file_name
                            .clone()
                            .unwrap_or_else(|| "upload".to_string()),
                        mime_type: upload
                            .mime_type
                            .clone()
                            .unwrap_or_else(|| "application/octet-stream".to_string()),
                        fields,
                    })
                }
            }
        }
    }
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

fn build_headers(
    provider_id: &str,
    destination: &str,
    raw: &HashMap<String, String>,
) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();

    for (name, value) in raw {
        let injected = inject_secrets_for(provider_id, destination, value)?;
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
        upload,
    } = request;

    let result = send(
        &request_id,
        &provider_id,
        &url,
        &method,
        &headers,
        body.as_deref(),
        upload.as_ref(),
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
    upload: Option<&RequestUpload>,
    cancelled: &CancelledRequests,
    on_chunk: &Channel<String>,
) -> Result<(), String> {
    // The origin is read from the URL as the frontend supplied it, before any
    // substitution. A placeholder in the host would therefore fail to match any
    // bound origin and the request is refused, rather than resolving into a host
    // the secret was never meant for.
    let destination = origin_of(url)?;

    let url = inject_secrets_for(provider_id, &destination, url)?;
    let mut header_map = build_headers(provider_id, &destination, headers)?;
    let payload = resolve_payload(body, upload, |text| {
        inject_secrets_for(provider_id, &destination, text)
    })?;

    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| format!("Unsupported method: {method}"))?;

    let client = reqwest::Client::new();
    let mut builder = client.request(method, &url);

    match payload {
        Payload::Empty => {}
        Payload::Text(text) => builder = builder.body(text),
        Payload::Binary { bytes } => builder = builder.body(bytes),
        Payload::Form {
            bytes,
            field,
            file_name,
            mime_type,
            fields,
        } => {
            // reqwest generates the boundary, so it owns Content-Type here. A
            // caller-supplied one would be missing the boundary and every
            // multipart upload would 400.
            header_map.remove(reqwest::header::CONTENT_TYPE);

            let part = reqwest::multipart::Part::bytes(bytes)
                .file_name(file_name)
                .mime_str(&mime_type)
                .map_err(|_| format!("Invalid upload content type: {mime_type}"))?;

            let mut form = reqwest::multipart::Form::new().part(field, part);
            for (name, value) in fields {
                form = form.text(name, value);
            }
            builder = builder.multipart(form);
        }
    }

    let response = builder
        .headers(header_map)
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
    fn the_request_deserializes_from_what_the_frontend_sends() {
        // transport.ts builds this object. Tauri converts a command's own
        // argument names to snake_case but leaves nested fields to serde, so
        // without a rename every provider request fails before it is sent with
        // "invalid args `request` for command `provider_request`: missing field
        // `request_id`". No JS stand-in catches it: the harness mock, the dev
        // proxy and the eval transport all read the camelCase keys directly.
        let payload = serde_json::json!({
            "requestId": "preq_1",
            "providerId": "openai",
            "url": "https://api.openai.com/v1/chat/completions",
            "method": "POST",
            "headers": { "content-type": "application/json" },
            "body": "{\"model\":\"gpt-4o\"}"
        });

        let request: ProviderRequest =
            serde_json::from_value(payload).expect("the frontend payload must deserialize");

        assert_eq!(request.request_id, "preq_1");
        assert_eq!(request.provider_id, "openai");
    }

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
    fn the_destination_is_read_before_substitution() {
        // A placeholder smuggled into the host must not resolve. Reading the
        // origin from the raw URL means it fails to match any bound origin.
        let smuggled = "https://{{OMNI_SECRET:API_KEY}}.evil.example/v1/chat";
        let origin = origin_of(smuggled);
        assert!(
            origin.is_err() || !origin.unwrap().contains("api.openai.com"),
            "a placeholder in the host must never resolve to a real provider origin"
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

    fn passthrough(text: &str) -> Result<String, String> {
        Ok(text.to_string())
    }

    fn upload(field: Option<&str>) -> RequestUpload {
        RequestUpload {
            data_base64: "aGVsbG8=".to_string(),
            field: field.map(str::to_string),
            file_name: Some("audio.wav".to_string()),
            mime_type: Some("audio/wav".to_string()),
            fields: HashMap::new(),
        }
    }

    #[test]
    fn no_body_and_no_upload_is_an_empty_payload() {
        assert!(matches!(
            resolve_payload(None, None, passthrough).unwrap(),
            Payload::Empty
        ));
    }

    #[test]
    fn a_text_body_still_gets_secret_injection() {
        let resolved = resolve_payload(Some("Bearer {{OMNI_SECRET:API_KEY}}"), None, |text| {
            Ok(text.replace("{{OMNI_SECRET:API_KEY}}", "sk-live"))
        })
        .unwrap();

        match resolved {
            Payload::Text(text) => assert_eq!(text, "Bearer sk-live"),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn an_upload_without_a_field_is_a_raw_binary_body() {
        match resolve_payload(None, Some(&upload(None)), passthrough).unwrap() {
            Payload::Binary { bytes } => assert_eq!(bytes, b"hello"),
            other => panic!("expected binary, got {other:?}"),
        }
    }

    #[test]
    fn an_upload_with_a_field_is_a_multipart_form() {
        match resolve_payload(None, Some(&upload(Some("file"))), passthrough).unwrap() {
            Payload::Form {
                bytes,
                field,
                file_name,
                mime_type,
                fields,
            } => {
                assert_eq!(bytes, b"hello");
                assert_eq!(field, "file");
                assert_eq!(file_name, "audio.wav");
                assert_eq!(mime_type, "audio/wav");
                assert!(fields.is_empty());
            }
            other => panic!("expected form, got {other:?}"),
        }
    }

    #[test]
    fn multipart_text_fields_get_secret_injection() {
        // Some providers authenticate with a form field rather than a header.
        let mut with_fields = upload(Some("file"));
        with_fields
            .fields
            .insert("token".to_string(), "{{OMNI_SECRET:API_KEY}}".to_string());

        match resolve_payload(None, Some(&with_fields), |text| {
            Ok(text.replace("{{OMNI_SECRET:API_KEY}}", "sk-live"))
        })
        .unwrap()
        {
            Payload::Form { fields, .. } => {
                assert_eq!(fields, vec![("token".to_string(), "sk-live".to_string())]);
            }
            other => panic!("expected form, got {other:?}"),
        }
    }

    #[test]
    fn multipart_fields_are_ordered_so_a_request_is_reproducible() {
        let mut with_fields = upload(Some("file"));
        with_fields
            .fields
            .insert("model".to_string(), "whisper-1".to_string());
        with_fields
            .fields
            .insert("language".to_string(), "en".to_string());
        with_fields
            .fields
            .insert("temperature".to_string(), "0".to_string());

        match resolve_payload(None, Some(&with_fields), passthrough).unwrap() {
            Payload::Form { fields, .. } => {
                let keys: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
                assert_eq!(keys, vec!["language", "model", "temperature"]);
            }
            other => panic!("expected form, got {other:?}"),
        }
    }

    #[test]
    fn the_uploaded_bytes_are_never_scanned_for_placeholders() {
        // Audio is arbitrary binary. Running the injector over it would either
        // corrupt it or, worse, report a missing secret for a byte sequence that
        // happens to look like a placeholder.
        let mut upload = upload(Some("file"));
        // base64 of `{{OMNI_SECRET:API_KEY}}`
        upload.data_base64 = "e3tPTU5JX1NFQ1JFVDpBUElfS0VZfX0=".to_string();

        match resolve_payload(None, Some(&upload), |_| {
            panic!("the injector must not see the uploaded bytes")
        })
        .unwrap()
        {
            Payload::Form { bytes, .. } => {
                assert_eq!(bytes, b"{{OMNI_SECRET:API_KEY}}");
            }
            other => panic!("expected form, got {other:?}"),
        }
    }

    #[test]
    fn a_body_and_an_upload_together_are_rejected() {
        // Ambiguous: there is one HTTP body. Guessing which one wins would send
        // a silently wrong request.
        let err = resolve_payload(Some("{}"), Some(&upload(None)), passthrough).unwrap_err();
        assert!(err.contains("body"), "the error should name the conflict: {err}");
    }

    #[test]
    fn unusable_base64_is_an_error_not_an_empty_upload() {
        let mut broken = upload(None);
        broken.data_base64 = "not base64 !!!".to_string();
        assert!(resolve_payload(None, Some(&broken), passthrough).is_err());
    }

    #[test]
    fn a_request_without_an_upload_still_deserializes() {
        // Every existing caller omits the field; a non-optional one would break
        // every chat request.
        let payload = serde_json::json!({
            "requestId": "preq_1",
            "providerId": "openai",
            "url": "https://api.openai.com/v1/chat/completions",
            "method": "POST",
            "headers": {},
            "body": "{}"
        });
        let request: ProviderRequest = serde_json::from_value(payload).unwrap();
        assert!(request.upload.is_none());
    }

    #[test]
    fn an_upload_deserializes_from_camel_case() {
        let payload = serde_json::json!({
            "requestId": "preq_2",
            "providerId": "openai-whisper",
            "url": "https://api.openai.com/v1/audio/transcriptions",
            "method": "POST",
            "headers": {},
            "upload": {
                "dataBase64": "aGVsbG8=",
                "field": "file",
                "fileName": "audio.mp4",
                "mimeType": "audio/mp4",
                "fields": { "model": "whisper-1" }
            }
        });
        let request: ProviderRequest = serde_json::from_value(payload).unwrap();
        let upload = request.upload.expect("the upload must deserialize");
        assert_eq!(upload.file_name.as_deref(), Some("audio.mp4"));
        assert_eq!(
            upload.fields.get("model").map(String::as_str),
            Some("whisper-1")
        );
    }
}
