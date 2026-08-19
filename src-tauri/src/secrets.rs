use keyring::Entry;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use url::Url;

/// Provider secrets live in the OS credential store, and there is deliberately
/// no command that hands one back to the webview.
///
/// The webview cannot be trusted with a key it can read. It can invoke the HTTP
/// plugin over IPC, and that plugin is allowed to reach any host, so injected
/// script that can read a key can also send it anywhere. A content security
/// policy does not help: the egress is IPC, not the page.
///
/// So the frontend never sees the value. It builds a request containing
/// `{{OMNI_SECRET:NAME}}` placeholders, and Rust substitutes them immediately
/// before the request goes out.
///
/// Each secret is bound to the origin it may be sent to, recorded when it is
/// stored. Without that binding this module would be an oracle: untrusted script
/// could ask for a request to its own server with an Authorization header
/// containing a placeholder, and Rust would stamp the real key onto it. Binding
/// means a placeholder only resolves when the request is going where the secret
/// belongs.

const SERVICE: &str = "com.connortessaro.omni";

/// `{{OMNI_SECRET:API_KEY}}`
static SECRET_PLACEHOLDER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\{\{OMNI_SECRET:([A-Za-z0-9_]+)\}\}").unwrap());

fn account_for(provider_id: &str, name: &str) -> String {
    format!("{provider_id}/{name}")
}

/// What the credential store holds: the value plus where it may be sent.
#[derive(Serialize, Deserialize)]
struct StoredSecret {
    value: String,
    origin: String,
}

/// Scheme, host and port. Path and query are irrelevant to where a request goes,
/// and including them would break the moment a provider changed an endpoint path.
pub fn origin_of(raw: &str) -> Result<String, String> {
    let parsed = Url::parse(raw).map_err(|_| format!("Not a valid URL: {raw}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("Unsupported scheme: {}", parsed.scheme()));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?;
    Ok(match parsed.port() {
        Some(port) => format!("{}://{}:{}", parsed.scheme(), host, port),
        None => format!("{}://{}", parsed.scheme(), host),
    })
}

fn entry(provider_id: &str, name: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &account_for(provider_id, name))
        .map_err(|e| format!("Could not open the credential store: {e}"))
}

/// Substitutes every placeholder using the supplied resolver.
///
/// Split out from the keyring so the substitution can be tested without
/// touching the real credential store. A missing secret is an error rather than
/// an empty string: sending a request with a blank Authorization header produces
/// a confusing 401 instead of an actionable message.
pub fn inject_secrets_with<F>(text: &str, mut resolve: F) -> Result<String, String>
where
    F: FnMut(&str) -> Option<String>,
{
    let mut missing: Vec<String> = Vec::new();

    let injected = SECRET_PLACEHOLDER
        .replace_all(text, |caps: &regex::Captures| {
            let name = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
            match resolve(name) {
                Some(value) => value,
                None => {
                    missing.push(name.to_string());
                    String::new()
                }
            }
        })
        .to_string();

    if !missing.is_empty() {
        missing.dedup();
        return Err(format!(
            "No stored value for {}. Add it in Dev space.",
            missing.join(", ")
        ));
    }

    Ok(injected)
}

/// Substitutes placeholders only when the destination matches the origin each
/// secret was bound to.
///
/// Split from the credential store so the binding check itself is testable: it is
/// the control that stops this module being an oracle, and a security control
/// with no test is a claim.
fn inject_bound_secrets_with<F>(
    text: &str,
    request_origin: &str,
    mut lookup: F,
) -> Result<String, String>
where
    F: FnMut(&str) -> Option<StoredSecret>,
{
    let mut wrong_destination: Vec<String> = Vec::new();

    let injected = inject_secrets_with(text, |name| match lookup(name) {
        Some(stored) if stored.origin == request_origin => Some(stored.value),
        Some(_) => {
            wrong_destination.push(name.to_string());
            None
        }
        None => None,
    });

    if !wrong_destination.is_empty() {
        wrong_destination.dedup();
        return Err(format!(
            "Refusing to send {} to {}: it is bound to a different origin.",
            wrong_destination.join(", "),
            request_origin
        ));
    }

    injected
}

pub fn inject_secrets_for(
    provider_id: &str,
    request_origin: &str,
    text: &str,
) -> Result<String, String> {
    inject_bound_secrets_with(text, request_origin, |name| {
        entry(provider_id, name)
            .ok()
            .and_then(|entry| entry.get_password().ok())
            .and_then(|raw| serde_json::from_str::<StoredSecret>(&raw).ok())
    })
}

/// True when the text carries at least one placeholder.
pub fn has_placeholder(text: &str) -> bool {
    SECRET_PLACEHOLDER.is_match(text)
}

/// `endpoint` is any URL the secret is allowed to be sent to; its origin is what
/// gets recorded.
#[tauri::command]
pub fn secret_store(
    provider_id: String,
    name: String,
    value: String,
    endpoint: String,
) -> Result<(), String> {
    if value.is_empty() {
        return Err("Refusing to store an empty secret".to_string());
    }
    let stored = StoredSecret {
        value,
        origin: origin_of(&endpoint)?,
    };
    let serialized = serde_json::to_string(&stored)
        .map_err(|e| format!("Could not serialize the secret: {e}"))?;

    entry(&provider_id, &name)?
        .set_password(&serialized)
        .map_err(|e| format!("Could not save to the credential store: {e}"))
}

#[tauri::command]
pub fn secret_delete(provider_id: String, name: String) -> Result<(), String> {
    match entry(&provider_id, &name)?.delete_credential() {
        Ok(()) => Ok(()),
        // Deleting something already absent is the desired end state.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not remove from the credential store: {e}")),
    }
}

/// Whether a secret is present. Deliberately returns a boolean and never the
/// value, so the webview can render "configured" without being able to read it.
#[tauri::command]
pub fn secret_exists(provider_id: String, name: String) -> Result<bool, String> {
    match entry(&provider_id, &name)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("Could not read the credential store: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn resolver(pairs: &[(&str, &str)]) -> impl FnMut(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name: &str| map.get(name).cloned()
    }

    #[test]
    fn substitutes_a_placeholder() {
        let out = inject_secrets_with(
            r#"{"headers":{"Authorization":"Bearer {{OMNI_SECRET:API_KEY}}"}}"#,
            resolver(&[("API_KEY", "sk-live-value")]),
        )
        .unwrap();
        assert!(out.contains("Bearer sk-live-value"));
        assert!(!out.contains("OMNI_SECRET"));
    }

    #[test]
    fn substitutes_every_occurrence_and_several_names() {
        let out = inject_secrets_with(
            "{{OMNI_SECRET:API_KEY}} {{OMNI_SECRET:ORG_ID}} {{OMNI_SECRET:API_KEY}}",
            resolver(&[("API_KEY", "aaa"), ("ORG_ID", "bbb")]),
        )
        .unwrap();
        assert_eq!(out, "aaa bbb aaa");
    }

    #[test]
    fn a_missing_secret_is_an_actionable_error_not_a_blank() {
        // A blank Authorization header produces a confusing 401 instead.
        let err = inject_secrets_with(
            "Bearer {{OMNI_SECRET:API_KEY}}",
            resolver(&[("SOMETHING_ELSE", "x")]),
        )
        .unwrap_err();
        assert!(err.contains("API_KEY"), "error should name the secret: {err}");
        assert!(err.contains("Dev space"), "error should say where to fix it");
    }

    #[test]
    fn text_without_placeholders_is_untouched() {
        let body = r#"{"model":"gpt-4o-mini","stream":true}"#;
        assert_eq!(
            inject_secrets_with(body, resolver(&[])).unwrap(),
            body
        );
        assert!(!has_placeholder(body));
    }

    #[test]
    fn detects_a_placeholder() {
        assert!(has_placeholder("x {{OMNI_SECRET:API_KEY}} y"));
        assert!(!has_placeholder("x {{API_KEY}} y"));
        assert!(
            !has_placeholder("{{OMNI_SECRET:}}"),
            "an empty name must not count as a placeholder"
        );
    }

    fn bound(value: &str, origin: &str) -> StoredSecret {
        StoredSecret {
            value: value.to_string(),
            origin: origin.to_string(),
        }
    }

    #[test]
    fn a_secret_resolves_when_the_destination_matches_its_binding() {
        let out = inject_bound_secrets_with(
            "Bearer {{OMNI_SECRET:API_KEY}}",
            "https://api.openai.com",
            |_| Some(bound("sk-live", "https://api.openai.com")),
        )
        .unwrap();
        assert_eq!(out, "Bearer sk-live");
    }

    #[test]
    fn a_secret_is_refused_when_the_destination_differs() {
        // The attack this exists to stop: untrusted script asks for a request to
        // its own server carrying a placeholder, hoping Rust stamps the real key
        // onto it.
        let err = inject_bound_secrets_with(
            "Bearer {{OMNI_SECRET:API_KEY}}",
            "https://evil.example",
            |_| Some(bound("sk-live", "https://api.openai.com")),
        )
        .unwrap_err();

        assert!(!err.contains("sk-live"), "the error must not leak the value");
        assert!(err.contains("API_KEY"));
        assert!(err.contains("bound to a different origin"));
    }

    #[test]
    fn a_matching_port_is_required_too() {
        // Otherwise any local service could collect an Ollama-bound credential.
        let err = inject_bound_secrets_with(
            "{{OMNI_SECRET:API_KEY}}",
            "http://localhost:9999",
            |_| Some(bound("local-token", "http://localhost:11434")),
        )
        .unwrap_err();
        assert!(err.contains("bound to a different origin"));
    }

    #[test]
    fn origin_ignores_path_and_query_but_keeps_the_port() {
        assert_eq!(
            origin_of("https://api.openai.com/v1/chat/completions").unwrap(),
            "https://api.openai.com"
        );
        assert_eq!(
            origin_of("https://api.example.com/v1/chat?key=abc").unwrap(),
            "https://api.example.com"
        );
        // Ollama is a legitimate loopback provider, so the port must survive.
        assert_eq!(
            origin_of("http://localhost:11434/v1/chat/completions").unwrap(),
            "http://localhost:11434"
        );
    }

    #[test]
    fn a_non_http_scheme_has_no_usable_origin() {
        assert!(origin_of("file:///etc/passwd").is_err());
        assert!(origin_of("not a url").is_err());
    }

    #[test]
    fn accounts_are_scoped_per_provider() {
        // Two providers holding a key under the same variable name must not
        // collide, or configuring one would overwrite the other.
        assert_ne!(
            account_for("openai", "API_KEY"),
            account_for("claude", "API_KEY")
        );
    }
}
