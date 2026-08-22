# Secret Migration Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move provider credentials out of the webview's localStorage entirely, so the OS credential store is the only copy.

**Architecture:** The provider request path already sends `{{OMNI_SECRET:NAME}}` placeholders and lets Rust substitute the real value for the bound origin. Two paths still read the plaintext value out of localStorage — model listing (`models.function.ts`) and speech-to-text (`stt.function.ts`) — so `secret-migration.ts` copies rather than moves. This plan converts both onto `streamProviderRequest`, teaches that transport to carry a binary upload (the reason STT was skipped), moves the Dev space UI onto `secret_store`/`secret_exists`/`secret_delete`, and only then deletes the localStorage copy.

**Tech Stack:** Tauri 2 + Rust (`reqwest` with the `multipart` feature already enabled, `base64 0.22`, `keyring`), React 19 + TypeScript strict, `node --test` with esbuild-bundled `src/` modules (`evals/harness/loadSrcModule.ts`).

**Spec:** `backlog/tasks/task-1 - Finish-the-secret-migration-move-keys-out-of-localStorage.md`

## Global Constraints

- Strict TypeScript. No `any` in new code; the existing `any` in `stt.function.ts` for the curl2Json result may stay where it is already.
- No comments unless the reason is non-obvious. When a comment is warranted, follow the house style already in `src-tauri/src/secrets.rs` and `evals/unit/stt-gemini.test.ts`: say why, and name the failure it prevents.
- No silent failures. A missing secret must produce an actionable error, never an empty string. `src-tauri/src/secrets.rs:70-98` is the precedent.
- **No command may ever return a secret value to the webview.** `secret_exists` returns a boolean on purpose (`src-tauri/src/secrets.rs:189-198`). Nothing in this plan adds a getter.
- Every new Tauri command must be added to `generate_handler!` in `src-tauri/src/lib.rs`; `npm run check:commands` is the gate.
- Test runner: `npm run eval:test` (`node --test evals/graders/*.test.ts evals/unit/*.test.ts`). Rust: `cd src-tauri && cargo test`.
- Typecheck gates: `npx tsc --noEmit` and `npm run eval:typecheck`.
- Conventional Commits. Commit at the end of every task.
- Secret variable names are matched by `/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i` (`src/lib/functions/transport.ts:18`). That regex is the single definition; mirror it, never redefine it.
- Credential store account format is `{providerId}/{NAME}` under service `com.connortessaro.omni` (`src-tauri/src/secrets.rs:26-34`). The stored payload is `{"value":...,"origin":...}` JSON.

---

## File Structure

**Rust**
- `src-tauri/src/provider.rs` — gains `RequestUpload`, `Payload`, `resolve_payload`. `provider_request` learns to send multipart and raw-binary bodies. The pure resolver is separated from the network so it can be unit-tested.

**Transport seam**
- `src/lib/functions/transport.ts` — gains `RequestUpload`, an `upload` field on `ProviderRequestParams`, and `secretExists`. Stays the single module the harness replaces.
- `evals/harness/node-transport.mjs` — mirrors both additions for Node.
- `evals/harness/loadSrcModule.ts` — the transport redirect becomes overridable so a test can supply a recording stub.
- `evals/unit/stubs/transport.ts` — new recording stub, modelled on `evals/unit/stubs/plugin-http.ts`.

**Request paths**
- `src/lib/functions/models.function.ts` — `tauriFetch` out, `streamProviderRequest` in.
- `src/lib/functions/stt.function.ts` — `tauriFetch` out, `streamProviderRequest` plus `upload` in.
- `src/lib/functions/ai-response.function.ts` — required-variable validation stops depending on a plaintext value.

**Storage and UI**
- `src/lib/storage/selected-provider.ts` — new. The single writer of the two selected-provider storage keys, stripping secret-named variables on the way out.
- `src/contexts/app.context.tsx` — persists through that helper, migrates STT as well as AI.
- `src/lib/functions/secret-migration.ts` — becomes a move: stores, then reports which names are now safe to drop.
- `src/pages/dev/components/ai-configs/Providers.tsx`, `src/pages/dev/components/stt-configs/Providers.tsx` — the API key field writes via `secret_store`, renders configured state via `secret_exists`, clears via `secret_delete`.

**Gates and tooling**
- `scripts/check-secret-storage.mjs` — new static gate.
- `scripts/set-stt-provider.mjs` — writes the keychain instead of planting a plaintext key.
- `.github/workflows/ci.yml` — runs the new gate.

---

### Task 1: Rust sends multipart and raw-binary bodies

`provider_request` takes `body: Option<String>` today, so an audio upload cannot go through it. This adds an `upload` field and a pure resolver, with no frontend change yet.

**Files:**
- Modify: `src-tauri/src/provider.rs:22-31` (the `ProviderRequest` struct), `:99-211` (`provider_request` and `send`)
- Test: `src-tauri/src/provider.rs:224-329` (the existing `mod tests`)

**Interfaces:**
- Consumes: `crate::secrets::{inject_secrets_for, origin_of}` (already imported at `provider.rs:10`).
- Produces:
  - `pub struct RequestUpload { data_base64: String, field: Option<String>, file_name: Option<String>, mime_type: Option<String>, fields: HashMap<String, String> }`, deserialized `camelCase`.
  - `pub enum Payload { Empty, Text(String), Binary { bytes: Vec<u8> }, Form { bytes: Vec<u8>, field: String, file_name: String, mime_type: String, fields: Vec<(String, String)> } }`
  - `pub fn resolve_payload<F>(body: Option<&str>, upload: Option<&RequestUpload>, inject: F) -> Result<Payload, String> where F: Fn(&str) -> Result<String, String>`
  - `ProviderRequest` gains `pub upload: Option<RequestUpload>`.

- [ ] **Step 1: Write the failing tests**

Append to `mod tests` in `src-tauri/src/provider.rs`:

```rust
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
        let resolved = resolve_payload(
            Some("Bearer {{OMNI_SECRET:API_KEY}}"),
            None,
            |text| Ok(text.replace("{{OMNI_SECRET:API_KEY}}", "sk-live")),
        )
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
        with_fields.fields.insert("model".to_string(), "whisper-1".to_string());
        with_fields.fields.insert("language".to_string(), "en".to_string());
        with_fields.fields.insert("temperature".to_string(), "0".to_string());

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
        assert_eq!(upload.fields.get("model").map(String::as_str), Some("whisper-1"));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/tessaro/omni/src-tauri && cargo test provider::`
Expected: FAIL to compile, with `cannot find function resolve_payload` and `cannot find type RequestUpload`.

- [ ] **Step 3: Implement the resolver and wire it into the request**

In `src-tauri/src/provider.rs`, add the imports at the top of the file:

```rust
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
```

Add `upload` to `ProviderRequest` (which currently ends at `provider.rs:31`):

```rust
    pub upload: Option<RequestUpload>,
```

Then add, after the `ProviderRequest` struct:

```rust
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
        (Some(_), Some(_)) => Err(
            "A request carries either a body or an upload, not both.".to_string(),
        ),
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
```

Change `provider_request` (`provider.rs:99-128`) to destructure and forward `upload`:

```rust
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
```

In `send`, add the `upload: Option<&RequestUpload>,` parameter after `body`, and replace the body-injection block (`provider.rs:147-161`) with:

```rust
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
```

Delete the now-duplicated `let mut builder = ... .headers(header_map);` and `if let Some(body) = body { ... }` lines and the old `let response = builder.send()...` that followed them.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/tessaro/omni/src-tauri && cargo test`
Expected: PASS, all provider and secrets tests green.

- [ ] **Step 5: Confirm nothing else broke**

Run: `cd /Users/tessaro/omni/src-tauri && cargo check --all-targets`
Expected: no errors. Warnings about `Payload` variants being unconstructed outside tests are acceptable until Task 4 lands.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/provider.rs
git commit -m "feat(provider): carry multipart and binary uploads through provider_request"
```

---

### Task 2: The transport seam learns about uploads and secret presence

The frontend cannot use Task 1 yet, and `models.function.ts` needs to ask whether a key exists without being able to read it. Both additions belong in `transport.ts`, which exists precisely so there is one thing to stub (`src/lib/functions/transport.ts:10-12`).

**Files:**
- Modify: `src/lib/functions/transport.ts:23-30` and `:68-71`
- Modify: `evals/harness/node-transport.mjs`
- Modify: `evals/harness/loadSrcModule.ts:26-46`, `:62-94`
- Create: `evals/unit/stubs/transport.ts`
- Create: `evals/unit/transport-stub.test.ts`

**Interfaces:**
- Consumes: `Payload`/`RequestUpload` shape from Task 1, over IPC as the `upload` member of the `request` argument.
- Produces:
  - `export interface RequestUpload { dataBase64: string; field?: string; fileName?: string; mimeType?: string; fields?: Record<string, string> }`
  - `ProviderRequestParams` gains `upload?: RequestUpload`.
  - `export const secretExists = (providerId: string, name: string): Promise<boolean>`
  - `evals/unit/stubs/transport.ts` exports `secretPlaceholder`, `isSecretVariable`, `secretExists`, `streamProviderRequest`, plus test controls `lastRequest()`, `requests`, `replyWith(body, status?)`, `setSecretExists(present)`, `reset()`.
  - `loadSrcModule` options gain `transport?: string`.

- [ ] **Step 1: Write the failing test**

Create `evals/unit/transport-stub.test.ts`:

```ts
// The harness replaces transport.ts wholesale, so the stub and the real module
// have to agree on their exported surface. A drift here does not fail a
// typecheck (one is a stub, one is production) and instead shows up as a test
// that passes against a shape production does not have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/loadSrcModule.ts";

const exportsOf = (relativePath: string): Set<string> => {
  const source = readFileSync(join(REPO_ROOT, relativePath), "utf8");
  const names = new Set<string>();
  const pattern =
    /export\s+(?:async\s+)?(?:const|function\*?|interface)\s+([A-Za-z0-9_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) names.add(match[1]);
  return names;
};

const RUNTIME_EXPORTS = [
  "secretPlaceholder",
  "isSecretVariable",
  "secretExists",
  "streamProviderRequest",
];

test("the real transport exports everything a request path needs", () => {
  const real = exportsOf("src/lib/functions/transport.ts");
  for (const name of RUNTIME_EXPORTS) {
    assert.ok(real.has(name), `transport.ts must export ${name}`);
  }
  assert.ok(
    real.has("RequestUpload"),
    "transport.ts must declare the RequestUpload interface"
  );
});

test("both stand-ins export the same runtime surface", () => {
  const node = exportsOf("evals/harness/node-transport.mjs");
  const stub = exportsOf("evals/unit/stubs/transport.ts");

  for (const name of RUNTIME_EXPORTS) {
    assert.ok(node.has(name), `node-transport.mjs must export ${name}`);
    assert.ok(stub.has(name), `stubs/transport.ts must export ${name}`);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/tessaro/omni && node --test evals/unit/transport-stub.test.ts`
Expected: FAIL with `transport.ts must export secretExists`, and a module-not-found for `evals/unit/stubs/transport.ts`.

- [ ] **Step 3: Add the two members to the real transport**

In `src/lib/functions/transport.ts`, after `isSecretVariable`:

```ts
/**
 * Bytes to upload, base64 so they survive IPC. `field` set means multipart with
 * the bytes in that field; absent means the bytes are the whole body.
 *
 * Rust assembles multipart rather than the frontend, because the body would
 * otherwise have to be a String and audio is not UTF-8.
 */
export interface RequestUpload {
  dataBase64: string;
  field?: string;
  fileName?: string;
  mimeType?: string;
  fields?: Record<string, string>;
}

/**
 * Whether a credential is configured, without reading it. There is deliberately
 * no command that returns the value.
 */
export const secretExists = (
  providerId: string,
  name: string
): Promise<boolean> => invoke<boolean>("secret_exists", { providerId, name });
```

Add `upload?: RequestUpload;` to `ProviderRequestParams` (after `body?: string;`), destructure it in `streamProviderRequest`'s parameter list alongside `body`, and include it in the invoke:

```ts
  const completed = invoke("provider_request", {
    request: { requestId, providerId, url, method, headers, body, upload },
    onChunk: channel,
  })
```

- [ ] **Step 4: Mirror both in the Node transport**

In `evals/harness/node-transport.mjs`, add after `isSecretVariable`:

```js
// A live run has a key in the environment; a dry run does not and does not need
// one, because nothing it talks to checks.
export const secretExists = async () =>
  Boolean(process.env.OMNI_EVAL_API_KEY);
```

and teach `streamProviderRequest` to accept `upload`, converting it to what `globalThis.fetch` understands:

```js
const bodyFor = (body, upload) => {
  if (upload) {
    const bytes = Buffer.from(upload.dataBase64, "base64");
    if (!upload.field) return bytes;

    const form = new FormData();
    form.append(
      upload.field,
      new Blob([bytes], { type: upload.mimeType ?? "application/octet-stream" }),
      upload.fileName ?? "upload"
    );
    for (const [name, value] of Object.entries(upload.fields ?? {})) {
      form.append(name, injectSecrets(value));
    }
    return form;
  }
  return body === undefined ? undefined : injectSecrets(body);
};
```

Then in `streamProviderRequest`, add `upload` to the destructured parameters and replace the `body:` line of the fetch call with `body: bodyFor(body, upload),`. When `upload?.field` is set, delete `content-type` from `injectedHeaders` before the fetch, for the same boundary reason as Rust:

```js
  if (upload?.field) {
    for (const name of Object.keys(injectedHeaders)) {
      if (name.toLowerCase() === "content-type") delete injectedHeaders[name];
    }
  }
```

- [ ] **Step 5: Make the transport redirect overridable**

In `evals/harness/loadSrcModule.ts`, replace the constant `redirectTransport` object with a factory, and add the option:

```ts
const transportRedirect = (target: string) => ({
  name: "redirect-transport",
  setup(build: {
    onResolve: (
      options: { filter: RegExp },
      callback: () => { path: string }
    ) => void;
  }) {
    build.onResolve({ filter: /(^|\/)transport(\.ts)?$/ }, () => ({
      path: target,
    }));
  },
});
```

Add to `LoadOptions`:

```ts
  /**
   * Replaces the Node transport with another module, so a test can record what
   * a request path assembled instead of issuing it.
   */
  transport?: string;
```

and in the `build` call change `plugins: [redirectTransport],` to:

```ts
    plugins: [transportRedirect(options.transport ?? NODE_TRANSPORT)],
```

- [ ] **Step 6: Write the recording stub**

Create `evals/unit/stubs/transport.ts`:

```ts
// Stands in for src/lib/functions/transport.ts. Records what a request path
// assembled and replies with a scripted body, so production assembly code can
// be exercised with no Tauri, no network and no key.
//
// State lives on globalThis for the same reason as the plugin-http stub:
// esbuild inlines this file into the bundle under test, so a test script's own
// import is a separate module instance.

export interface RequestUpload {
  dataBase64: string;
  field?: string;
  fileName?: string;
  mimeType?: string;
  fields?: Record<string, string>;
}

export interface RecordedRequest {
  providerId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  upload?: RequestUpload;
}

interface TransportStubStore {
  requests: RecordedRequest[];
  reply: { status: number; body: string };
  secretPresent: boolean;
}

const STORE_KEY = "__omniTransportStub__";

const store: TransportStubStore = ((globalThis as Record<string, unknown>)[
  STORE_KEY
] ??= {
  requests: [],
  reply: { status: 200, body: "{}" },
  secretPresent: true,
}) as TransportStubStore;

export const requests = store.requests;

export const lastRequest = (): RecordedRequest | undefined =>
  store.requests[store.requests.length - 1];

export const replyWith = (body: unknown, status = 200): void => {
  store.reply = {
    status,
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
};

export const setSecretExists = (present: boolean): void => {
  store.secretPresent = present;
};

export const reset = (): void => {
  store.requests.length = 0;
  store.reply = { status: 200, body: "{}" };
  store.secretPresent = true;
};

export const secretPlaceholder = (name: string): string =>
  `{{OMNI_SECRET:${name}}}`;

const SECRET_NAME_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

export const isSecretVariable = (name: string): boolean =>
  SECRET_NAME_PATTERN.test(name);

export const secretExists = async (): Promise<boolean> => store.secretPresent;

export async function* streamProviderRequest(params: {
  providerId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  upload?: RequestUpload;
  signal?: AbortSignal;
}): AsyncIterable<string> {
  store.requests.push({
    providerId: params.providerId,
    url: params.url,
    method: params.method,
    headers: params.headers,
    body: params.body,
    upload: params.upload,
  });

  // Rust reports a non-2xx as a thrown error, never as a chunk, and the callers
  // depend on that.
  if (store.reply.status < 200 || store.reply.status >= 300) {
    throw new Error(
      `Provider returned ${store.reply.status}: ${store.reply.body}`
    );
  }

  yield store.reply.body;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd /Users/tessaro/omni && node --test evals/unit/transport-stub.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 8: Confirm nothing regressed**

Run: `cd /Users/tessaro/omni && npx tsc --noEmit && npm run eval:typecheck && npm run eval:test && npm run eval:dry-run`
Expected: all pass. The existing suites still route through `node-transport.mjs`, which is unchanged for callers that pass no `upload`.

- [ ] **Step 9: Commit**

```bash
git add src/lib/functions/transport.ts evals/harness/node-transport.mjs evals/harness/loadSrcModule.ts evals/unit/stubs/transport.ts evals/unit/transport-stub.test.ts
git commit -m "feat(transport): expose secret presence and binary uploads through the one seam"
```

---

### Task 3: Model listing stops reading the key (AC #1)

`models.function.ts:187-196` pulls `variables.API_KEY` and hands it to `tauriFetch`. After this task it sends a placeholder through the transport and asks `secretExists` whether a key is configured at all.

**Files:**
- Modify: `src/lib/functions/models.function.ts:1-12`, `:107-129`, `:131-143`, `:161-214`
- Modify: `evals/unit/models.test.ts` (whole file — it stubs the HTTP plugin, which this path no longer uses)
- Modify: `scripts/verify-model-listing.mjs:26-27` (comment only)

**Interfaces:**
- Consumes: `secretPlaceholder`, `secretExists`, `streamProviderRequest` from Task 2; `evals/unit/stubs/transport.ts` controls `replyWith`, `lastRequest`, `setSecretExists`, `reset`.
- Produces: `listModels` keeps its exported signature `({ providerId, variables, curl, signal }: ListModelsParams) => Promise<string[]>`. `variables` now only feeds URL derivation for custom providers.

- [ ] **Step 1: Write the failing tests**

Replace `evals/unit/models.test.ts` in full:

```ts
// Covers model listing: the parsers, the auth style each provider needs, the
// filtering that keeps non-chat models out of a chat model picker, and the one
// property that makes placeholder auth work at all — the model-list endpoint
// has to sit on the same origin as the chat endpoint, because a secret is bound
// to an origin and refused anywhere else.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSrcModule } from "../harness/loadSrcModule.ts";
import { installMemoryLocalStorage } from "../harness/fakeGlobals.ts";
import {
  lastRequest,
  replyWith,
  reset,
  setSecretExists,
} from "./stubs/transport.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRANSPORT_STUB = join(HERE, "stubs", "transport.ts");

interface ModelsModule {
  listModels: (params: {
    providerId: string;
    variables: Record<string, string>;
    curl?: string;
  }) => Promise<string[]>;
  readCachedModels: (providerId: string) => string[] | null;
  writeCachedModels: (providerId: string, models: string[]) => void;
  MODEL_LIST_SOURCES: Record<string, { url: string; auth: string }>;
}

interface AiProvidersModule {
  AI_PROVIDERS: { id: string; curl: string }[];
}

installMemoryLocalStorage();

const { listModels, readCachedModels, writeCachedModels, MODEL_LIST_SOURCES } =
  await loadSrcModule<ModelsModule>("lib/functions/models.function.ts", {
    transport: TRANSPORT_STUB,
  });

const { AI_PROVIDERS } = await loadSrcModule<AiProvidersModule>(
  "config/ai-providers.constants.ts"
);

const openAiShape = (...ids: string[]) => ({
  object: "list",
  data: ids.map((id) => ({ id, object: "model" })),
});

const originOf = (url: string) => new URL(url).origin;

beforeEach(() => reset());

test("openai-shaped responses yield model ids", async () => {
  replyWith(openAiShape("gpt-4o-mini", "gpt-4o"));
  const models = await listModels({
    providerId: "openai",
    variables: {},
  });
  assert.deepEqual(models, ["gpt-4o-mini", "gpt-4o"]);
});

test("the key is sent as a placeholder, never as a value", async () => {
  // The whole point of the task: nothing in the webview holds the credential,
  // so there is nothing for injected script to read.
  replyWith(openAiShape("gpt-4o"));
  await listModels({
    providerId: "openai",
    variables: { API_KEY: "sk-should-be-ignored" },
  });

  const request = lastRequest();
  assert.equal(request?.headers.Authorization, "Bearer {{OMNI_SECRET:API_KEY}}");
  assert.doesNotMatch(
    JSON.stringify(request),
    /sk-should-be-ignored/,
    "no part of the request may carry the literal key"
  );
});

test("the request is attributed to the provider so Rust looks up the right account", async () => {
  // Credential store accounts are `{providerId}/{NAME}`. A wrong providerId
  // reads someone else's key or none at all.
  replyWith(openAiShape("claude-sonnet-4-5"));
  await listModels({ providerId: "claude", variables: {} });
  assert.equal(lastRequest()?.providerId, "claude");
});

test("gemini ids have their models/ prefix stripped", async () => {
  replyWith(openAiShape("models/gemini-2.5-flash", "models/gemini-2.5-pro"));
  const models = await listModels({ providerId: "gemini", variables: {} });
  assert.deepEqual(models, ["gemini-2.5-flash", "gemini-2.5-pro"]);
  assert.match(lastRequest()?.url ?? "", /\/v1beta\/openai\/models$/);
});

test("anthropic is called with x-api-key and a version header, not bearer", async () => {
  replyWith(openAiShape("claude-sonnet-4-5", "claude-haiku-4-5"));
  await listModels({ providerId: "claude", variables: {} });

  const request = lastRequest();
  assert.equal(request?.headers["x-api-key"], "{{OMNI_SECRET:API_KEY}}");
  assert.equal(request?.headers["anthropic-version"], "2023-06-01");
  assert.equal(
    request?.headers.Authorization,
    undefined,
    "anthropic rejects bearer auth on this endpoint"
  );
});

test("cohere's models[].name shape is read", async () => {
  replyWith({ models: [{ name: "command-r" }, { name: "command-r-plus" }] });
  const models = await listModels({ providerId: "cohere", variables: {} });
  assert.deepEqual(models, ["command-r", "command-r-plus"]);
});

test("a provider that needs no auth sends no credential header", async () => {
  replyWith(openAiShape("meta-llama/llama-3-8b"));
  await listModels({ providerId: "openrouter", variables: {} });

  const request = lastRequest();
  assert.equal(request?.headers.Authorization, undefined);
  assert.equal(request?.headers["x-api-key"], undefined);
});

test("a provider with no stored key is told to add one, before any request", async () => {
  setSecretExists(false);
  await assert.rejects(
    () => listModels({ providerId: "openai", variables: {} }),
    /Add an API key/
  );
  assert.equal(
    lastRequest(),
    undefined,
    "asking a provider for models with no key wastes a round trip and 401s"
  );
});

test("a provider that needs no auth lists models with no stored key", async () => {
  setSecretExists(false);
  replyWith({ models: [{ name: "llama3.2" }] });
  const models = await listModels({ providerId: "ollama", variables: {} });
  assert.deepEqual(models, ["llama3.2"]);
});

test("non-chat models are filtered out", async () => {
  replyWith(
    openAiShape("gpt-4o", "text-embedding-3-small", "dall-e-3", "whisper-1")
  );
  const models = await listModels({ providerId: "openai", variables: {} });
  assert.deepEqual(models, ["gpt-4o"]);
});

test("a filter that would empty the picker returns the unfiltered list", async () => {
  replyWith(openAiShape("text-embedding-3-small"));
  const models = await listModels({ providerId: "openai", variables: {} });
  assert.deepEqual(models, ["text-embedding-3-small"]);
});

test("an error status surfaces with the provider's own detail", async () => {
  replyWith("insufficient quota", 429);
  await assert.rejects(
    () => listModels({ providerId: "openai", variables: {} }),
    /429|insufficient quota/
  );
});

test("a custom provider's model endpoint is derived from its chat endpoint", async () => {
  replyWith(openAiShape("local-model"));
  const models = await listModels({
    providerId: "custom-1",
    variables: { API_KEY: "sk-ignored" },
    curl: 'curl -X POST "https://llm.example.com/v1/chat/completions" -H "Authorization: Bearer {{API_KEY}}"',
  });

  assert.deepEqual(models, ["local-model"]);
  assert.equal(lastRequest()?.url, "https://llm.example.com/v1/models");
});

test("a custom provider's derived url carries a placeholder, not a key", async () => {
  // Some providers authenticate in the query string, so the derived URL is a
  // place a key could leak.
  replyWith(openAiShape("local-model"));
  await listModels({
    providerId: "custom-2",
    variables: { API_KEY: "sk-should-be-ignored" },
    curl: 'curl -X POST "https://llm.example.com/v1/chat?key={{API_KEY}}"',
  });

  assert.doesNotMatch(
    lastRequest()?.url ?? "",
    /sk-should-be-ignored/,
    "a key in a derived query string is still a key in the webview"
  );
});

test("every table entry lists models on the same origin as its chat endpoint", () => {
  // A secret is bound to the origin recorded when it was stored, which comes
  // from the chat endpoint. A model-list endpoint on a different host would be
  // refused by inject_bound_secrets_with, and the failure reads like a bad key.
  for (const [providerId, source] of Object.entries(MODEL_LIST_SOURCES)) {
    const provider = AI_PROVIDERS.find((p) => p.id === providerId);
    if (!provider) continue;

    const chatUrl = provider.curl.match(/https?:\/\/[^\s"'\\]+/)?.[0];
    assert.ok(chatUrl, `${providerId} has no URL in its curl template`);
    assert.equal(
      originOf(source.url),
      originOf(chatUrl),
      `${providerId} lists models on a different origin than it chats on, so its bound secret will be refused`
    );
  }
});

test("cached models survive a round trip and expire", () => {
  writeCachedModels("openai", ["gpt-4o"]);
  assert.deepEqual(readCachedModels("openai"), ["gpt-4o"]);
  assert.equal(readCachedModels("nothing-cached"), null);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/tessaro/omni && node --test evals/unit/models.test.ts`
Expected: FAIL. `MODEL_LIST_SOURCES` is not exported, and `lastRequest()` is `undefined` because `listModels` still calls `tauriFetch`.

- [ ] **Step 3: Convert `listModels` onto the transport**

In `src/lib/functions/models.function.ts`, replace the imports at the top:

```ts
import curl2Json from "@bany/curl-to-json";
import { deepVariableReplacer } from "./common.function";
import {
  isSecretVariable,
  secretExists,
  secretPlaceholder,
  streamProviderRequest,
} from "./transport";

/**
 * Lists the models a provider will serve for the key already configured, so a
 * model can be switched without re-entering credentials.
 *
 * Requests go through the provider transport, not the webview's fetch: it
 * bypasses CORS (most provider APIs send no CORS headers) and, more
 * importantly, it means the credential stays in the OS credential store. This
 * path sends `{{OMNI_SECRET:API_KEY}}` and Rust substitutes the real value, but
 * only for the origin that secret is bound to — which is why every entry in
 * MODEL_LIST_SOURCES has to sit on the same origin as its chat endpoint.
 */
```

Export the table so the origin-parity test can read it (`models.function.ts:30`):

```ts
export const MODEL_LIST_SOURCES: Record<string, ModelListSource> = {
```

Replace `buildHeaders` (`:131-143`) with a placeholder-based version:

```ts
const buildHeaders = (
  source: ModelListSource,
  needsCredential: boolean
): Record<string, string> => {
  const headers: Record<string, string> = { ...source.headers };
  if (!needsCredential) return headers;

  const placeholder = secretPlaceholder("API_KEY");
  if (source.auth === "bearer") headers.Authorization = `Bearer ${placeholder}`;
  if (source.auth === "x-api-key") headers["x-api-key"] = placeholder;
  return headers;
};
```

Give `deriveSourceFromCurl` placeholder-safe variables (`:107-129`), replacing its body's first block:

```ts
const deriveSourceFromCurl = (
  curl: string,
  variables: Record<string, string>
): ModelListSource | null => {
  // A custom provider can authenticate in the query string, so the derived URL
  // has to carry a placeholder rather than the value.
  const safeVariables = Object.fromEntries(
    Object.entries(variables).map(([name, value]) => [
      name.toUpperCase(),
      isSecretVariable(name) ? secretPlaceholder(name.toUpperCase()) : value,
    ])
  );

  let url: string;
  try {
    const parsed = curl2Json(curl);
    url = deepVariableReplacer(parsed.url ?? "", safeVariables) as string;
  } catch {
    return null;
  }
  if (!url) return null;
```

Leave the rest of that function unchanged.

Replace the body of `listModels` from the `const apiKey` line (`:187`) through the `readIds` call (`:207`):

```ts
  const needsCredential = source.auth !== "none";
  if (needsCredential && !(await secretExists(providerId, "API_KEY"))) {
    throw new Error("Add an API key for this provider first.");
  }

  let raw = "";
  for await (const chunk of streamProviderRequest({
    providerId,
    url: source.url,
    method: "GET",
    headers: buildHeaders(source, needsCredential),
    signal,
  })) {
    raw += chunk;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(
      `${providerId} returned a model list that is not JSON: ${raw.slice(0, 160)}`
    );
  }

  const ids = readIds(payload, source);
```

The old `!response.ok` block is gone: Rust throws on a non-2xx and already includes the provider's detail (`src-tauri/src/provider.rs:168-180`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/tessaro/omni && node --test evals/unit/models.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Update the live verification script's comment**

In `scripts/verify-model-listing.mjs`, replace lines 26-27:

```js
// listModels no longer reads a key out of the provider's variables; the Node
// transport substitutes OMNI_EVAL_API_KEY for the placeholder and reports the
// secret as present when that variable is set.
const variables = {};
```

- [ ] **Step 6: Confirm the whole suite is green**

Run: `cd /Users/tessaro/omni && npx tsc --noEmit && npm run eval:typecheck && npm run eval:test && npm run eval:dry-run && npm run build`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/functions/models.function.ts evals/unit/models.test.ts scripts/verify-model-listing.mjs
git commit -m "feat(models): list models through the transport with a placeholder key"
```

---

### Task 4: Speech-to-text stops reading the key (AC #2)

`stt.function.ts:196` calls `tauriFetch` with the literal value in a header. All ten templates in `src/config/stt.constants.ts` put `{{API_KEY}}` in a header, never in the body, so the placeholder path covers every one; what was missing was a way to send the audio, which Task 1 added.

This task also fixes a latent bug in the same code it rewrites: `stt.function.ts:132` hardcodes the multipart file field as `"file"`, so `speechmatics-stt` (`data_file`) and `rev-ai-stt` (`media`) upload under the wrong name and fail. The field is now read from whichever `-F` entry holds `{{AUDIO}}`.

**Files:**
- Modify: `src/lib/functions/stt.function.ts:1-10`, `:76-251`
- Modify: `evals/unit/stt-gemini.test.ts` (whole file — it stubs `globalThis.fetch`, which this path no longer uses)
- Create: `evals/unit/stt-upload.test.ts`

**Interfaces:**
- Consumes: `RequestUpload`, `secretPlaceholder`, `isSecretVariable`, `streamProviderRequest` from Task 2.
- Produces: `fetchSTT` keeps its exported signature `(params: STTParams) => Promise<string>`.

- [ ] **Step 1: Write the failing tests for the three upload shapes**

Create `evals/unit/stt-upload.test.ts`:

```ts
// Covers the three body shapes the ten templates in stt.constants.ts need, and
// the one invariant that spans all of them: the credential is a placeholder.
//
// The audio itself cannot be a String, which is why these go through the
// transport's `upload` rather than its `body`. Getting the shape wrong is a
// silent failure: a multipart field under the wrong name reads back as "no
// audio provided", and a raw-binary provider handed a form reads back as a
// corrupt file.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSrcModule } from "../harness/loadSrcModule.ts";
import { installFileReader } from "../harness/fakeGlobals.ts";
import { lastRequest, replyWith, reset } from "./stubs/transport.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRANSPORT_STUB = join(HERE, "stubs", "transport.ts");

interface SttModule {
  fetchSTT(params: {
    provider: { curl: string; responseContentPath?: string } | undefined;
    selectedProvider: { provider: string; variables: Record<string, string> };
    audio: File | Blob;
  }): Promise<string>;
}

interface SttConstantsModule {
  SPEECH_TO_TEXT_PROVIDERS: {
    id: string;
    curl: string;
    responseContentPath: string;
  }[];
}

installFileReader();

const { fetchSTT } = await loadSrcModule<SttModule>(
  "lib/functions/stt.function.ts",
  { transport: TRANSPORT_STUB }
);
const { SPEECH_TO_TEXT_PROVIDERS } = await loadSrcModule<SttConstantsModule>(
  "config/stt.constants.ts"
);

const providerNamed = (id: string) => {
  const provider = SPEECH_TO_TEXT_PROVIDERS.find((p) => p.id === id);
  assert.ok(provider, `${id} must be registered in stt.constants.ts`);
  return provider;
};

const audio = () => new Blob(["fake-wav"], { type: "audio/wav" });
const AUDIO_BASE64 = Buffer.from("fake-wav").toString("base64");

beforeEach(() => reset());

const transcribe = (id: string, replyBody: unknown) => {
  replyWith(replyBody);
  return fetchSTT({
    provider: providerNamed(id),
    selectedProvider: {
      provider: id,
      variables: { api_key: "sk-should-be-ignored", model: "whisper-1" },
    },
    audio: audio(),
  });
};

test("a -F provider uploads multipart with its own text fields", async () => {
  const text = await transcribe("openai-whisper", { text: "hello there" });
  assert.equal(text, "hello there");

  const upload = lastRequest()?.upload;
  assert.equal(upload?.field, "file");
  assert.equal(upload?.dataBase64, AUDIO_BASE64);
  assert.equal(upload?.mimeType, "audio/wav");
  assert.equal(upload?.fileName, "audio.wav");
  assert.equal(upload?.fields?.model, "whisper-1");
  assert.equal(lastRequest()?.body, undefined, "a multipart request has no text body");
});

test("a -F provider's non-file fields all survive", async () => {
  await transcribe("groq", { text: "hi" });

  const fields = lastRequest()?.upload?.fields ?? {};
  assert.equal(fields.model, "whisper-1");
  assert.equal(fields.temperature, "0");
  assert.equal(fields.response_format, "text");
  assert.equal(fields.language, "en");
});

test("the multipart file field is the one the template names, not always 'file'", async () => {
  // speechmatics wants data_file and rev.ai wants media. Hardcoding "file"
  // uploads under a name they ignore, and the error reads like a missing file.
  await transcribe("speechmatics-stt", { job: { id: "job-1" } });
  assert.equal(lastRequest()?.upload?.field, "data_file");

  await transcribe("rev-ai-stt", { id: "job-2" });
  assert.equal(lastRequest()?.upload?.field, "media");
});

test("a --data-binary provider sends the bytes as the whole body", async () => {
  await transcribe("deepgram-stt", {
    results: { channels: [{ alternatives: [{ transcript: "raw bytes" }] }] },
  });

  const upload = lastRequest()?.upload;
  assert.equal(upload?.field, undefined, "a raw body has no multipart field");
  assert.equal(upload?.dataBase64, AUDIO_BASE64);
  assert.equal(lastRequest()?.headers["Content-Type"], "audio/wav");
});

test("a JSON provider inlines base64 in the body and sends no upload", async () => {
  await transcribe("gemini-stt", {
    candidates: [{ content: { parts: [{ text: "inline" }] } }],
  });

  const request = lastRequest();
  assert.equal(request?.upload, undefined);
  const body = JSON.parse(request?.body ?? "{}");
  assert.equal(body.contents[0].parts[1].inline_data.data, AUDIO_BASE64);
});

test("no template's request carries the literal key, in any shape", async () => {
  const replies: Record<string, unknown> = {
    "gemini-stt": { candidates: [{ content: { parts: [{ text: "x" }] } }] },
    "openai-whisper": { text: "x" },
    groq: { text: "x" },
    "elevenlabs-stt": { text: "x" },
    "google-stt": {
      results: [{ alternatives: [{ transcript: "x" }] }],
    },
    "deepgram-stt": {
      results: { channels: [{ alternatives: [{ transcript: "x" }] }] },
    },
    "azure-stt": { DisplayText: "x" },
    "speechmatics-stt": { job: { id: "x" } },
    "rev-ai-stt": { id: "x" },
    "ibm-watson-stt": { results: [{ alternatives: [{ transcript: "x" }] }] },
  };

  for (const provider of SPEECH_TO_TEXT_PROVIDERS) {
    reset();
    await fetchSTT({
      provider,
      selectedProvider: {
        provider: provider.id,
        variables: {
          api_key: "sk-should-be-ignored",
          model: "m",
          region: "eastus",
          project_id: "p",
          options: "{}",
        },
      },
      audio: audio(),
    });

    const serialized = JSON.stringify(lastRequest());
    assert.doesNotMatch(
      serialized,
      /sk-should-be-ignored/,
      `${provider.id} put the literal key in its request`
    );
    assert.match(
      serialized,
      /\{\{OMNI_SECRET:API_KEY\}\}/,
      `${provider.id} sent no placeholder, so Rust has nothing to substitute`
    );
    void replies[provider.id];
  }
});

test("the request is attributed to the provider so Rust finds the right account", async () => {
  await transcribe("openai-whisper", { text: "x" });
  assert.equal(lastRequest()?.providerId, "openai-whisper");
});
```

Note on the last loop: `replyWith` is not called per provider inside it, so every request gets the default `{}` reply and `fetchSTT` rejects on a missing transcription. Wrap the call so the assertion still runs:

```ts
    await fetchSTT({ /* as above */ }).catch(() => "");
```

Use that form; the assertions are about what was sent, not what came back.

- [ ] **Step 2: Rewrite the Gemini test onto the transport stub**

Replace the harness section of `evals/unit/stt-gemini.test.ts` (its lines 1-98) with the transport-stub equivalent, keeping the "Why this exists" comment block and all seven existing tests below it:

```ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSrcModule } from "../harness/loadSrcModule.ts";
import { installFileReader } from "../harness/fakeGlobals.ts";
import { lastRequest, replyWith, reset } from "./stubs/transport.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRANSPORT_STUB = join(HERE, "stubs", "transport.ts");
```

Keep the `SttModule` and `SttConstantsModule` interfaces and the existing comment block unchanged. Change the module load to pass the stub:

```ts
const { fetchSTT } = await loadSrcModule<SttModule>(
  "lib/functions/stt.function.ts",
  { transport: TRANSPORT_STUB }
);
```

Replace the `Captured` interface and `transcribe` helper with:

```ts
interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

beforeEach(() => reset());

/** Runs fetchSTT against the recording transport and returns what it assembled. */
async function transcribe(
  audio: Blob,
  responseBody = transcriptResponse("hello there")
): Promise<{ result: string; sent: Captured }> {
  assert.ok(gemini, "the gemini-stt provider must be registered");
  replyWith(responseBody);

  const result = await fetchSTT({
    provider: gemini,
    selectedProvider: {
      provider: "gemini-stt",
      variables: { api_key: "test-key", model: "gemini-2.5-flash" },
    },
    audio,
  });

  const request = lastRequest();
  assert.ok(request, "fetchSTT must have issued a request");
  return {
    result,
    sent: {
      url: request.url,
      headers: request.headers,
      body: JSON.parse(request.body ?? "{}"),
    },
  };
}
```

Change the first test's key assertion, since the header now carries a placeholder:

```ts
test("the model and key land in the URL and headers, not the body", async () => {
  const { sent } = await transcribe(new Blob(["fake-wav"], { type: "audio/wav" }));

  assert.match(sent.url, /models\/gemini-2\.5-flash:generateContent/);
  assert.equal(sent.headers["x-goog-api-key"], "{{OMNI_SECRET:API_KEY}}");
  assert.doesNotMatch(
    JSON.stringify(sent),
    /test-key/,
    "the key must never be in the request, in the header or the body"
  );
});
```

Leave the other six tests exactly as they are.

- [ ] **Step 3: Run both files to verify they fail**

Run: `cd /Users/tessaro/omni && node --test evals/unit/stt-upload.test.ts evals/unit/stt-gemini.test.ts`
Expected: FAIL. `lastRequest()` is `undefined` because `fetchSTT` still calls `tauriFetch`, and the key assertions see `test-key`.

- [ ] **Step 4: Convert `fetchSTT` onto the transport**

In `src/lib/functions/stt.function.ts`, replace the imports:

```ts
import {
  deepVariableReplacer,
  getByPath,
  blobToBase64,
} from "./common.function";
import {
  isSecretVariable,
  secretPlaceholder,
  streamProviderRequest,
  type RequestUpload,
} from "./transport";

import { TYPE_PROVIDER } from "@/types";
import curl2Json from "@bany/curl-to-json";
```

Replace the variable map construction (`:76-84`) with the placeholder version:

```ts
    // A credential is replaced by a placeholder, not its value: Rust
    // substitutes the real one at send time, so nothing here ever holds a key.
    const allVariables: Record<string, string> = Object.fromEntries(
      Object.entries(selectedProvider.variables).map(([key, value]) => [
        key.toUpperCase(),
        isSecretVariable(key) ? secretPlaceholder(key.toUpperCase()) : value,
      ])
    );
```

Replace everything from `let finalHeaders = { ...headers };` (`:122`) through the `throw new Error(\`HTTP ...\`)` block (`:223`) with:

```ts
    const finalHeaders: Record<string, string> = { ...headers };
    let body: string | undefined;
    let upload: RequestUpload | undefined;

    const fileName = getAudioFileName(audio.type);
    const mimeType = audio.type.split(";")[0].trim().toLowerCase();

    const isForm =
      provider.curl.includes("-F ") || provider.curl.includes("--form");

    if (isForm) {
      // curl2Json returns -F entries either keyed by name or, when the flag was
      // unquoted, as numbered "name=value" strings.
      const entries: [string, string][] = [];
      for (const [key, value] of Object.entries(formData)) {
        if (typeof value !== "string") continue;
        if (/^\d+$/.test(key)) {
          const [name, ...rest] = value.split("=");
          entries.push([name, rest.join("=")]);
        } else {
          entries.push([key, value]);
        }
      }

      // The field the audio belongs in is whichever one the template pointed at
      // {{AUDIO}}. Hardcoding "file" uploads under a name speechmatics and
      // rev.ai ignore, and their error reads like a missing file.
      const audioEntry = entries.find(([, value]) => value.includes("{{AUDIO}}"));
      const headerNames = new Set(
        Object.keys(headers).map((name) =>
          name.toUpperCase().replace(/[-_]/g, "")
        )
      );

      const fields = Object.fromEntries(
        entries.filter(
          ([name, value]) =>
            name !== audioEntry?.[0] &&
            value &&
            !headerNames.has(name.toUpperCase().replace(/[-_]/g, ""))
        )
      );

      upload = {
        dataBase64: await blobToBase64(audio),
        field: audioEntry?.[0] ?? "file",
        fileName,
        mimeType,
        fields,
      };
      // Rust owns Content-Type for multipart: it holds the boundary.
      delete finalHeaders["Content-Type"];
    } else if (isBinaryUpload) {
      upload = {
        dataBase64: await blobToBase64(audio),
        fileName,
        mimeType,
      };
    } else {
      allVariables.AUDIO = await blobToBase64(audio);
      // Providers that take inline audio have to be told what the bytes are.
      // The two recorders disagree — system audio is WAV, the mic goes through
      // WKWebView's MediaRecorder and comes out audio/mp4 — so a template
      // cannot hardcode it.
      allVariables.MIME = mimeType;
      const dataObj = curlJson.data ? { ...curlJson.data } : {};
      body = JSON.stringify(deepVariableReplacer(dataObj, allVariables));
    }

    // Always the Rust client, never the webview's fetch: it bypasses CORS (most
    // provider APIs send no CORS headers) and it keeps the credential in the OS
    // credential store, so injected script has nothing to read and nowhere to
    // send it.
    const method = (curlJson.method || "POST").toUpperCase();
    let responseText = "";
    for await (const chunk of streamProviderRequest({
      providerId: selectedProvider.provider,
      url,
      method,
      headers: finalHeaders,
      body: method === "GET" ? undefined : body,
      upload: method === "GET" ? undefined : upload,
    })) {
      responseText += chunk;
    }
```

Then delete the now-dead `let data: any;` re-declaration overlap by keeping the existing tail from `let data: any;` (`:226`) onward unchanged — it already parses `responseText`.

Remove the now-unused `Response` type usage and the `fetchFunction` binding. `isBinaryUpload` (`:103`) and `rawParams`/`queryString` handling (`:105-120`) stay as they are.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/tessaro/omni && node --test evals/unit/stt-upload.test.ts evals/unit/stt-gemini.test.ts`
Expected: PASS, 15 tests across the two files.

- [ ] **Step 6: Confirm the whole suite is green**

Run: `cd /Users/tessaro/omni && npx tsc --noEmit && npm run eval:typecheck && npm run eval:test && npm run build`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/functions/stt.function.ts evals/unit/stt-gemini.test.ts evals/unit/stt-upload.test.ts
git commit -m "feat(stt): transcribe through the transport with a placeholder key"
```

---

### Task 5: Required-variable validation stops depending on a plaintext value

This is the coupling that turns Task 7 into an outage if it is skipped. `ai-response.function.ts:138-151` rejects a request when any curl variable is empty in `selectedProvider.variables`. Once the key is deleted from there, **every chat request fails** with `Missing required variable: API_KEY`.

**Files:**
- Modify: `src/lib/functions/ai-response.function.ts:138-151`
- Create: `evals/unit/required-variables.test.ts`

**Interfaces:**
- Consumes: `isSecretVariable`, `secretExists` from Task 2 (`isSecretVariable` is already imported at `ai-response.function.ts:11`).
- Produces: no signature change to `fetchAIResponse`.

- [ ] **Step 1: Write the failing test**

Create `evals/unit/required-variables.test.ts`:

```ts
// The migration deletes the key from localStorage, so the pre-flight check in
// fetchAIResponse can no longer read it. If that check keeps treating a secret
// like any other variable, every chat request fails with "Missing required
// variable: API_KEY" — the credential is present, just not where this code was
// looking.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSrcModule } from "../harness/loadSrcModule.ts";
import { installMemoryLocalStorage } from "../harness/fakeGlobals.ts";
import { lastRequest, replyWith, reset, setSecretExists } from "./stubs/transport.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRANSPORT_STUB = join(HERE, "stubs", "transport.ts");

interface AiResponseModule {
  fetchAIResponse(params: {
    provider: { id: string; curl: string; responseContentPath?: string; streaming?: boolean };
    selectedProvider: { provider: string; variables: Record<string, string> };
    userMessage: string;
  }): AsyncIterable<string>;
}

installMemoryLocalStorage();

const { fetchAIResponse } = await loadSrcModule<AiResponseModule>(
  "lib/functions/ai-response.function.ts",
  { transport: TRANSPORT_STUB }
);

const provider = {
  id: "openai",
  curl: `curl -X POST "https://api.openai.com/v1/chat/completions" -H "Authorization: Bearer {{API_KEY}}" -d '{"model":"{{MODEL}}","messages":[],"stream":false}'`,
  responseContentPath: "choices[0].message.content",
  streaming: false,
};

const drain = async (variables: Record<string, string>): Promise<string> => {
  let text = "";
  for await (const chunk of fetchAIResponse({
    provider,
    selectedProvider: { provider: "openai", variables },
    userMessage: "hello",
  })) {
    text += chunk;
  }
  return text;
};

beforeEach(() => reset());

test("a request goes out with no key in the variables map", async () => {
  replyWith({ choices: [{ message: { content: "hi" } }] });
  const answer = await drain({ model: "gpt-4o-mini" });

  assert.equal(answer, "hi");
  assert.equal(
    lastRequest()?.headers.Authorization,
    "Bearer {{OMNI_SECRET:API_KEY}}"
  );
});

test("a non-secret variable that is still missing is reported", async () => {
  // MODEL has no credential store to fall back on, so this check has to keep
  // working for everything that is not a secret.
  await assert.rejects(() => drain({}), /Missing required variable: MODEL/);
});

test("no stored credential is reported before a request is issued", async () => {
  setSecretExists(false);
  await assert.rejects(
    () => drain({ model: "gpt-4o-mini" }),
    /API_KEY/,
    "the error must name the credential so the user knows what to add"
  );
  assert.equal(lastRequest(), undefined, "a keyless request is a guaranteed 401");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/tessaro/omni && node --test evals/unit/required-variables.test.ts`
Expected: FAIL. The first test rejects with `Missing required variable: API_KEY`.

- [ ] **Step 3: Split the check**

In `src/lib/functions/ai-response.function.ts`, add `secretExists` to the existing transport import (`:10-14`), then replace `:138-151`:

```ts
    const extractedVariables = extractVariables(provider.curl);
    const requiredVars = extractedVariables.filter(
      ({ key }) => key !== "SYSTEM_PROMPT" && key !== "TEXT" && key !== "IMAGE"
    );

    for (const { key } of requiredVars) {
      // A credential is not in the variables map any more; it lives in the OS
      // credential store, so its presence is a question for Rust.
      if (isSecretVariable(key)) {
        if (!(await secretExists(selectedProvider.provider, key.toUpperCase()))) {
          throw new Error(
            `Missing ${key.toUpperCase()}. Add it in Dev space.`
          );
        }
        continue;
      }

      if (
        !selectedProvider.variables?.[key] ||
        selectedProvider.variables[key].trim() === ""
      ) {
        throw new Error(
          `Missing required variable: ${key}. Please configure it in settings.`
        );
      }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/tessaro/omni && node --test evals/unit/required-variables.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Confirm the request-assembly gates still pass**

Run: `cd /Users/tessaro/omni && npx tsc --noEmit && npm run eval:test && npm run eval:dry-run`
Expected: all pass. The dry run exercises `fetchAIResponse` against every provider template through `node-transport.mjs`, whose `secretExists` returns true when `OMNI_EVAL_API_KEY` is set — export a dummy value if the dry run reports a missing credential: `OMNI_EVAL_API_KEY=dry-run npm run eval:dry-run`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/functions/ai-response.function.ts evals/unit/required-variables.test.ts
git commit -m "fix(chat): check a credential in the store, not in the variables map"
```

---

### Task 6: Dev space writes credentials to the store (AC #3)

Both provider panels currently push the typed key straight into `selectedProvider.variables`, which is what persists it. They now call `secret_store` on save, render configured state from `secret_exists`, and clear with `secret_delete`.

**REQUIRED SUB-SKILL for this task:** invoke `frontend-design` before the first edit and `web-design-guidelines` for the review pass, per `~/.claude/rules/frontend.md`. Verify visually at desktop and ~390px, not only by typecheck. Copy in this panel is customer-visible: invoke `stop-slop` on the strings, and use no em dashes.

**Files:**
- Modify: `src/lib/functions/secret-migration.ts` (export `endpointFor`)
- Create: `src/hooks/useProviderSecret.ts`
- Modify: `src/pages/dev/components/ai-configs/Providers.tsx:56-202`
- Modify: `src/pages/dev/components/stt-configs/Providers.tsx:28-172`
- Create: `evals/unit/provider-secret.test.ts`

**Interfaces:**
- Consumes: `secretExists` from Task 2; `secret_store` and `secret_delete` commands (`src-tauri/src/secrets.rs:157-198`), both already in `generate_handler!` (`src-tauri/src/lib.rs:72-75`).
- Produces:
  - `src/lib/functions/secret-migration.ts` exports `endpointFor(curl: string, variables: Record<string, string>): string | null`.
  - `src/hooks/useProviderSecret.ts` exports
    `useProviderSecret(providerId: string, name: string, endpoint: string | null): { configured: boolean; pending: boolean; error: string | null; save(value: string): Promise<void>; clear(): Promise<void> }`.

- [ ] **Step 1: Write the failing test for the endpoint derivation**

Create `evals/unit/provider-secret.test.ts`:

```ts
// A stored secret is bound to an origin, and that origin comes from the
// provider's own curl. Deriving it with the secret still substituted would put
// the key in the origin for providers that authenticate in the query string,
// which is the leak this whole change exists to close.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrcModule } from "../harness/loadSrcModule.ts";

interface MigrationModule {
  endpointFor(
    curl: string,
    variables: Record<string, string>
  ): string | null;
}

const { endpointFor } = await loadSrcModule<MigrationModule>(
  "lib/functions/secret-migration.ts"
);

test("an endpoint is read out of the curl template", () => {
  assert.equal(
    endpointFor(
      'curl -X POST "https://api.openai.com/v1/chat/completions" -H "Authorization: Bearer {{API_KEY}}"',
      {}
    ),
    "https://api.openai.com/v1/chat/completions"
  );
});

test("a non-secret variable in the path is substituted", () => {
  assert.equal(
    endpointFor(
      'curl -X POST "https://{{REGION}}.stt.speech.microsoft.com/speech/recognition"',
      { REGION: "eastus" }
    ),
    "https://eastus.stt.speech.microsoft.com/speech/recognition"
  );
});

test("a template with no usable url yields null rather than a guess", () => {
  assert.equal(endpointFor("curl --help", {}), null);
  assert.equal(endpointFor('curl "not a url"', {}), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/tessaro/omni && node --test evals/unit/provider-secret.test.ts`
Expected: FAIL with `endpointFor is not a function` — it is module-private today (`src/lib/functions/secret-migration.ts:26`).

- [ ] **Step 3: Export `endpointFor` and add the percent-encoding fix**

In `src/lib/functions/secret-migration.ts`, change line 26 from `const endpointFor = (` to:

```ts
/** The endpoint a secret is allowed to be sent to, from the provider's own curl. */
export const endpointFor = (
```

and inside it, restore braces before substitution, the same trap `stt.function.ts:88-97` documents:

```ts
  try {
    const parsed = curl2Json(curl);
    // curl2Json percent-encodes the URL, so a {{VAR}} in the path arrives as
    // %7B%7BVAR%7D%7D and leaves deepVariableReplacer nothing to match.
    const raw = (parsed.url ?? "")
      .replace(/%7B%7B/gi, "{{")
      .replace(/%7D%7D/gi, "}}");
    const url = deepVariableReplacer(raw, variables) as string;
    return url && /^https?:\/\//.test(url) ? url : null;
  } catch {
    return null;
  }
```

- [ ] **Step 4: Run the endpoint tests to verify they pass**

Run: `cd /Users/tessaro/omni && node --test evals/unit/provider-secret.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the hook**

Create `src/hooks/useProviderSecret.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { secretExists } from "@/lib/functions/transport";

/**
 * A provider credential, as much of it as the webview is allowed to know: it
 * can be written, cleared, and asked about, never read.
 */
export const useProviderSecret = (
  providerId: string,
  name: string,
  endpoint: string | null
) => {
  const [configured, setConfigured] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!providerId || !name) {
      setConfigured(false);
      return;
    }
    try {
      setConfigured(await secretExists(providerId, name));
    } catch (cause) {
      setConfigured(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [providerId, name]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (value: string) => {
      if (!value.trim()) return;
      if (!endpoint) {
        setError(
          "This provider has no valid endpoint, so there is nowhere to bind the key."
        );
        return;
      }
      setPending(true);
      setError(null);
      try {
        await invoke("secret_store", {
          providerId,
          name,
          value,
          endpoint,
        });
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setPending(false);
      }
    },
    [providerId, name, endpoint, refresh]
  );

  const clear = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await invoke("secret_delete", { providerId, name });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }, [providerId, name, refresh]);

  return { configured, pending, error, save, clear };
};
```

Export it from `src/hooks/index.ts` alongside the existing hooks.

- [ ] **Step 6: Convert the AI provider panel**

In `src/pages/dev/components/ai-configs/Providers.tsx`:

Add the imports:

```ts
import { useProviderSecret } from "@/hooks";
import { endpointFor, isSecretVariable } from "@/lib";
import { CheckIcon } from "lucide-react";
```

(`endpointFor` and `isSecretVariable` need re-exporting from `src/lib/functions/index.ts` if they are not already reachable through `@/lib`; check that barrel first and add them if not.)

Delete `getApiKeyValue` and `isApiKeyEmpty` (`:60-68`) and replace them with local state plus the hook:

```ts
  const [draftKey, setDraftKey] = useState("");

  const activeProvider = allAiProviders?.find(
    (p) => p?.id === selectedAIProvider?.provider
  );

  const nonSecretVariables = Object.fromEntries(
    Object.entries(selectedAIProvider?.variables ?? {})
      .filter(([name]) => !isSecretVariable(name))
      .map(([name, value]) => [name.toUpperCase(), value])
  );

  const secret = useProviderSecret(
    selectedAIProvider?.provider ?? "",
    "API_KEY",
    activeProvider?.curl ? endpointFor(activeProvider.curl, nonSecretVariables) : null
  );
```

Replace the whole API-key block (`:108-202`) with a field that never writes the value into `variables`:

```tsx
      {findKeyAndValue("api_key") ? (
        <div className="space-y-2">
          <Header
            title="API Key"
            description={
              secret.configured
                ? "Saved to your keychain. Omni sends it from there, so it is never stored in the app."
                : `Enter your ${
                    activeProvider?.isCustom
                      ? "custom provider"
                      : selectedAIProvider?.provider
                  } API key. It goes straight to your keychain.`
            }
          />

          <div className="flex gap-2">
            <Input
              type="password"
              placeholder={secret.configured ? "Saved" : "**********"}
              value={draftKey}
              onChange={(value) =>
                setDraftKey(
                  typeof value === "string" ? value : value.target.value
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void secret.save(draftKey).then(() => setDraftKey(""));
                }
              }}
              disabled={secret.pending}
              className="flex-1 h-11 border-1 border-input/50 focus:border-primary/50 transition-colors"
            />

            {secret.configured && !draftKey.trim() ? (
              <Button
                onClick={() => void secret.clear()}
                disabled={secret.pending}
                size="icon"
                variant="destructive"
                className="shrink-0 h-11 w-11"
                title="Remove API key"
              >
                <TrashIcon className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                onClick={() =>
                  void secret.save(draftKey).then(() => setDraftKey(""))
                }
                disabled={secret.pending || !draftKey.trim()}
                size="icon"
                className="shrink-0 h-11 w-11"
                title="Save API key"
              >
                <KeyIcon className="h-4 w-4" />
              </Button>
            )}
          </div>

          {secret.configured ? (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <CheckIcon className="h-3 w-3" />
              Key saved for {selectedAIProvider?.provider}
            </p>
          ) : null}

          {secret.error ? (
            <p className="text-[11px] text-destructive">{secret.error}</p>
          ) : null}
        </div>
      ) : null}
```

The non-secret variable loop below it (`:204-307`) is unchanged: those are configuration, not credentials, and belong in `variables`.

- [ ] **Step 7: Convert the STT provider panel the same way**

Apply the identical change to `src/pages/dev/components/stt-configs/Providers.tsx`, substituting `selectedSttProvider`, `onSetSelectedSttProvider`, `allSttProviders`, and `sttVariables` for their AI equivalents. The copy differs only in the provider noun: "STT provider" rather than "AI provider".

- [ ] **Step 8: Verify in the app, at both widths**

Run in one shell: `cd /Users/tessaro/omni && npm run dev`
Then drive the Dev space with the `agent-browser` CLI (`--profile Default`), or open it by hand:
1. Select a provider, type a key, press the save button. The field clears and "Key saved for &lt;provider&gt;" appears.
2. Reload. The configured line is still there and the field is empty, proving it came from `secret_exists` and not from React state.
3. Press the trash button. The line disappears.
4. Screenshot at desktop width and at 390px. The row must not clip; `~/.claude/rules/frontend.md` requires both.

- [ ] **Step 9: Confirm the gates**

Run: `cd /Users/tessaro/omni && npx tsc --noEmit && npm run check:commands && npm run eval:test && npm run build`
Expected: all pass. `check:commands` should now report `secret_delete` as invoked rather than unused.

- [ ] **Step 10: Commit**

```bash
git add src/lib/functions/secret-migration.ts src/lib/functions/index.ts src/hooks/useProviderSecret.ts src/hooks/index.ts src/pages/dev/components/ai-configs/Providers.tsx src/pages/dev/components/stt-configs/Providers.tsx evals/unit/provider-secret.test.ts
git commit -m "feat(dev-space): save provider keys to the credential store, never to the app"
```

---

### Task 7: The migration becomes a move (AC #4)

Everything that read the plaintext copy is converted, so it can finally be deleted. `secret-migration.ts` currently copies on purpose (`:6-13`); it now reports which names it stored, and `app.context.tsx` strips those from state and from what it persists. STT gets migrated too, which it never was.

**Files:**
- Create: `src/lib/storage/selected-provider.ts`
- Modify: `src/lib/functions/secret-migration.ts:1-13`, `:39-82`
- Modify: `src/contexts/app.context.tsx:419-438`, `:452-456`
- Modify: `src/lib/storage/index.ts` (barrel)
- Create: `evals/unit/selected-provider.test.ts`

**Interfaces:**
- Consumes: `isSecretVariable` from `transport.ts`; `secret_store` / `secret_exists`.
- Produces:
  - `src/lib/storage/selected-provider.ts` exports
    `withoutSecrets(variables: Record<string, string>): Record<string, string>` and
    `persistSelectedProvider(storageKey: string, selected: { provider: string; variables: Record<string, string> }): void`.
  - `migrateProviderSecrets` return type changes from `Promise<void>` to `Promise<string[]>`, the upper-cased names now held by the credential store.

- [ ] **Step 1: Write the failing test**

Create `evals/unit/selected-provider.test.ts`:

```ts
// The end state the whole task is for: what lands in localStorage carries no
// credential. This is checked here rather than by reading the real
// localstorage.sqlite3, because a unit test runs in CI and a keychain does not.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadSrcModule } from "../harness/loadSrcModule.ts";
import { installMemoryLocalStorage } from "../harness/fakeGlobals.ts";

interface SelectedProviderModule {
  withoutSecrets(variables: Record<string, string>): Record<string, string>;
  persistSelectedProvider(
    storageKey: string,
    selected: { provider: string; variables: Record<string, string> }
  ): void;
}

installMemoryLocalStorage();

const { withoutSecrets, persistSelectedProvider } =
  await loadSrcModule<SelectedProviderModule>(
    "lib/storage/selected-provider.ts"
  );

beforeEach(() => localStorage.clear());

test("secret-named variables are dropped and everything else survives", () => {
  assert.deepEqual(
    withoutSecrets({
      api_key: "sk-live",
      model: "gpt-4o-mini",
      region: "eastus",
      auth_token: "tok",
      project_id: "p",
    }),
    { model: "gpt-4o-mini", region: "eastus", project_id: "p" }
  );
});

test("what is written holds neither the name nor the value of a secret", () => {
  persistSelectedProvider("curl_selected_ai_provider", {
    provider: "openai",
    variables: { api_key: "sk-live-value", model: "gpt-4o-mini" },
  });

  const written = localStorage.getItem("curl_selected_ai_provider") ?? "";
  assert.doesNotMatch(written, /sk-live-value/);
  assert.doesNotMatch(written, /api_key/);
  assert.match(written, /gpt-4o-mini/);
  assert.equal(JSON.parse(written).provider, "openai");
});

test("a provider with no variables at all still round-trips", () => {
  persistSelectedProvider("curl_selected_stt_provider", {
    provider: "gemini-stt",
    variables: {},
  });
  assert.deepEqual(
    JSON.parse(localStorage.getItem("curl_selected_stt_provider") ?? "{}"),
    { provider: "gemini-stt", variables: {} }
  );
});

test("an empty provider id is not persisted", () => {
  // The context runs this effect on mount, before anything is selected.
  persistSelectedProvider("curl_selected_ai_provider", {
    provider: "",
    variables: {},
  });
  assert.equal(localStorage.getItem("curl_selected_ai_provider"), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/tessaro/omni && node --test evals/unit/selected-provider.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the single writer**

Create `src/lib/storage/selected-provider.ts`:

```ts
import { isSecretVariable } from "@/lib/functions/transport";
import { safeLocalStorage } from "./helper";

/**
 * The only place a selected provider is written to localStorage.
 *
 * Credentials live in the OS credential store. The file behind localStorage is
 * mode 644 and readable by any process running as the user with no prompt,
 * where the keychain copy is ACL-gated, so a variable whose name marks it as a
 * credential is dropped rather than persisted. scripts/check-secret-storage.mjs
 * enforces that nothing else writes these keys.
 */
export const withoutSecrets = (
  variables: Record<string, string>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(variables ?? {}).filter(([name]) => !isSecretVariable(name))
  );

export const persistSelectedProvider = (
  storageKey: string,
  selected: { provider: string; variables: Record<string, string> }
): void => {
  if (!selected?.provider) return;
  safeLocalStorage.setItem(
    storageKey,
    JSON.stringify({
      provider: selected.provider,
      variables: withoutSecrets(selected.variables),
    })
  );
};
```

Add it to `src/lib/storage/index.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/tessaro/omni && node --test evals/unit/selected-provider.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Make the migration report what it stored**

In `src/lib/functions/secret-migration.ts`, replace the doc comment (`:6-13`):

```ts
/**
 * Moves provider credentials out of localStorage into the OS credential store.
 *
 * Returns the upper-cased names the store now holds, so the caller can drop
 * them from state. Every request path reads secrets from the store now — the
 * chat transport, model listing and speech-to-text — so there is nothing left
 * that needs the plaintext copy.
 */
```

Change the signature and body of `migrateProviderSecrets` (`:39-82`):

```ts
export const migrateProviderSecrets = async (
  selected: SelectedProvider | null | undefined,
  providers: ProviderLike[]
): Promise<string[]> => {
  if (!selected?.provider || !selected.variables) return [];

  const provider = providers.find((candidate) => candidate.id === selected.provider);
  if (!provider?.curl) return [];

  // Non-secret variables only, or the endpoint would contain the key itself for
  // providers that authenticate via the query string.
  const safeVariables = Object.fromEntries(
    Object.entries(selected.variables)
      .filter(([name]) => !isSecretVariable(name))
      .map(([name, value]) => [name.toUpperCase(), value])
  );

  const endpoint = endpointFor(provider.curl, safeVariables);
  if (!endpoint) return [];

  const stored: string[] = [];

  for (const [name, value] of Object.entries(selected.variables)) {
    if (!isSecretVariable(name) || !value) continue;

    const upperName = name.toUpperCase();
    try {
      const alreadyStored = await invoke<boolean>("secret_exists", {
        providerId: selected.provider,
        name: upperName,
      });

      if (!alreadyStored) {
        await invoke("secret_store", {
          providerId: selected.provider,
          name: upperName,
          value,
          endpoint,
        });
      }

      stored.push(upperName);
    } catch (error) {
      // A failed migration must not stop the app from starting, and must not
      // report the name as stored: dropping the only copy of a key the store
      // never accepted would lose it.
      console.error(`Could not migrate ${upperName} to the credential store:`, error);
    }
  }

  return stored;
};
```

- [ ] **Step 6: Persist through the helper and migrate STT too**

In `src/contexts/app.context.tsx`, add `persistSelectedProvider` and `withoutSecrets` to the `@/lib` import, then replace the two sync effects (`:419-438`):

```tsx
  // Sync selected AI to localStorage. Credentials are stripped on the way out;
  // persistSelectedProvider is the only writer of these keys.
  useEffect(() => {
    persistSelectedProvider(
      STORAGE_KEYS.SELECTED_AI_PROVIDER,
      selectedAIProvider
    );
  }, [selectedAIProvider]);

  useEffect(() => {
    persistSelectedProvider(
      STORAGE_KEYS.SELECTED_STT_PROVIDER,
      selectedSttProvider
    );
  }, [selectedSttProvider]);
```

Replace the migration effect (`:452-456`) with one that drops what it moved, for both provider kinds:

```tsx
  // Credentials belong in the OS credential store, not localStorage. Runs on
  // every provider change so a key entered in Dev space lands there too, then
  // drops the plaintext copy from state so the next persist cannot write it.
  useEffect(() => {
    void (async () => {
      const moved = await migrateProviderSecrets(
        selectedAIProvider,
        allAiProviders
      );
      if (moved.length === 0) return;
      setSelectedAIProvider((prev) => ({
        ...prev,
        variables: withoutSecrets(prev.variables),
      }));
    })();
  }, [selectedAIProvider, allAiProviders]);

  useEffect(() => {
    void (async () => {
      const moved = await migrateProviderSecrets(
        selectedSttProvider,
        allSttProviders
      );
      if (moved.length === 0) return;
      setSelectedSttProvider((prev) => ({
        ...prev,
        variables: withoutSecrets(prev.variables),
      }));
    })();
  }, [selectedSttProvider, allSttProviders]);
```

The `moved.length === 0` guard is what stops the effect looping: once the variables hold no secret, `migrateProviderSecrets` returns an empty array and no state update is queued.

- [ ] **Step 7: Verify against the real app and the real file**

Run in one shell: `cd /Users/tessaro/omni && npm run dev`
Then, with a key already configured from Task 6:

```bash
python3 - <<'PY'
import glob, sqlite3
for path in glob.glob(
    "/Users/tessaro/Library/WebKit/com.connortessaro.omni/WebsiteData/Default/*/*/LocalStorage/localstorage.sqlite3"
):
    print(path)
    rows = sqlite3.connect(f"file:{path}?mode=ro", uri=True).execute(
        "SELECT key, value FROM ItemTable WHERE key LIKE 'curl_selected%'"
    ).fetchall()
    for key, value in rows:
        text = value.decode("utf-16-le", "replace") if isinstance(value, bytes) else str(value)
        print(f"  {key} = {text}")
PY
```

Expected: the `curl_selected_ai_provider` and `curl_selected_stt_provider` values contain `provider` and non-secret variables only. No `api_key`, no key material. Run it before the change too, so the difference is on the record.

Then confirm the app still works end to end: send a HUD prompt, switch models with the quick switcher, and record a voice input. All three are the paths that used to read the deleted copy.

- [ ] **Step 8: Confirm the gates**

Run: `cd /Users/tessaro/omni && npx tsc --noEmit && npm run eval:test && npm run eval:dry-run && npm run build`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/lib/storage/selected-provider.ts src/lib/storage/index.ts src/lib/functions/secret-migration.ts src/contexts/app.context.tsx evals/unit/selected-provider.test.ts
git commit -m "feat(secrets): move keys out of localStorage instead of copying them"
```

---

### Task 8: A gate that keeps the key out (AC #5)

The invariant is one edit away from being lost: any new `setItem` of a selected provider re-introduces the plaintext copy, and no typecheck notices. This adds a static check in the shape of `scripts/check-commands.mjs`, which exists for the same reason.

**Files:**
- Create: `scripts/check-secret-storage.mjs`
- Modify: `package.json` (scripts)
- Modify: `.github/workflows/ci.yml` (the frontend job)

**Interfaces:**
- Consumes: nothing at runtime; it reads `src/` as text.
- Produces: `npm run check:secrets`, exit code 1 on a violation.

- [ ] **Step 1: Write the check so it fails on the current tree**

Create `scripts/check-secret-storage.mjs`:

```js
// Keeps provider credentials out of localStorage.
//
// The file behind localStorage is mode 644 and readable by any process running
// as the user with no prompt; the keychain copy is ACL-gated. That gap is the
// whole reason the credential store exists, and it is one careless setItem away
// from being reopened. Nothing in the type system spans it, so it needs a check
// of its own — the same reason check-commands.mjs exists.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

/** The only module allowed to write the selected-provider keys. */
const SOLE_WRITER = join("src", "lib", "storage", "selected-provider.ts");

/** Storage keys whose payload carries a provider's variables. */
const GUARDED_KEYS = ["SELECTED_AI_PROVIDER", "SELECTED_STT_PROVIDER"];

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const violations = [];

for (const file of walk(SRC)) {
  if (!/\.(ts|tsx)$/.test(file)) continue;
  const relativePath = relative(REPO_ROOT, file);
  if (relativePath === SOLE_WRITER) continue;

  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (!/setItem\s*\(/.test(line)) return;
    for (const key of GUARDED_KEYS) {
      if (line.includes(key)) {
        violations.push({
          site: `${relativePath}:${index + 1}`,
          detail: `writes ${key} directly; use persistSelectedProvider from ${SOLE_WRITER}`,
        });
      }
    }
  });
}

// The stripper itself has to keep using the shared definition of "secret",
// or the two drift and a renamed variable slips through.
const writerSource = readFileSync(join(REPO_ROOT, SOLE_WRITER), "utf8");
if (!writerSource.includes("isSecretVariable")) {
  violations.push({
    site: SOLE_WRITER,
    detail:
      "does not use isSecretVariable from transport.ts, so it has its own idea of what a secret is",
  });
}

for (const { site, detail } of violations) {
  console.error(`LEAK  ${site}`);
  console.error(`      ${detail}`);
}

console.log(
  `\n${GUARDED_KEYS.length} guarded key(s), ${violations.length} violation(s)`
);

if (violations.length > 0) {
  console.error(
    `\n${violations.length} site(s) can persist a credential in plaintext.`
  );
  process.exitCode = 1;
}
```

- [ ] **Step 2: Run it and confirm it reports nothing**

Run: `cd /Users/tessaro/omni && node scripts/check-secret-storage.mjs`
Expected: `2 guarded key(s), 0 violation(s)`, exit 0. Task 7 already removed the direct writes.

- [ ] **Step 3: Prove the check actually catches a regression**

Temporarily add to `src/contexts/app.context.tsx`, anywhere inside the component:

```ts
    safeLocalStorage.setItem(STORAGE_KEYS.SELECTED_AI_PROVIDER, "leak");
```

Run: `cd /Users/tessaro/omni && node scripts/check-secret-storage.mjs; echo "exit=$?"`
Expected: `LEAK src/contexts/app.context.tsx:<line>` and `exit=1`.

Then remove the line and re-run to confirm it is clean again. A gate that has never failed is a claim, not a gate.

- [ ] **Step 4: Wire it into the scripts and CI**

In `package.json`, next to `check:commands`:

```json
    "check:secrets": "node scripts/check-secret-storage.mjs",
```

In `.github/workflows/ci.yml`, in the frontend job immediately after the `Tauri command parity` step:

```yaml
      - name: Secrets stay out of localStorage
        run: npm run check:secrets
```

- [ ] **Step 5: Confirm the full local gate set**

Run: `cd /Users/tessaro/omni && npx tsc --noEmit && npm run eval:typecheck && npm run check:commands && npm run check:secrets && npm run eval:test && npm run eval:dry-run && npm run build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-secret-storage.mjs package.json .github/workflows/ci.yml
git commit -m "test(secrets): gate against a credential going back into localStorage"
```

---

### Task 9: The provider-selection script writes the keychain

`scripts/set-stt-provider.mjs:155` writes `variables: { api_key: apiKey, model }` straight into the webview's localStorage, so running it re-plants exactly what Task 7 removed. It is a Node script and cannot invoke a Tauri command, but the keyring crate stores a generic password on macOS, so `security` can write the same row.

**Files:**
- Modify: `scripts/set-stt-provider.mjs`

**Interfaces:**
- Consumes: the credential store layout from `src-tauri/src/secrets.rs:26-41` — service `com.connortessaro.omni`, account `{providerId}/{NAME}`, password `{"value":...,"origin":...}` JSON where `origin` is scheme, host and port only.
- Produces: no exported API. The script's localStorage write now carries no credential.

- [ ] **Step 1: Record what the script does today**

Run: `cd /Users/tessaro/omni && node scripts/set-stt-provider.mjs --provider gemini-stt --model gemini-2.5-flash`
Then re-run the sqlite reader from Task 7 Step 7, widening the filter to `'curl_selected_stt_provider'`. Expected before the fix: the value contains `api_key` and the key itself. Keep that output; it is what this task removes.

- [ ] **Step 2: Add the keychain writer**

In `scripts/set-stt-provider.mjs`, add near the top:

```js
import { execFileSync } from "node:child_process";

const KEYCHAIN_SERVICE = "com.connortessaro.omni";

/**
 * Writes a credential where the app reads it. keyring-rs stores a generic
 * password keyed by service and account, and secrets.rs wraps the value with
 * the origin it may be sent to, so the row has to carry that same JSON.
 */
const storeSecret = (providerId, name, value, endpoint) => {
  const { protocol, hostname, port } = new URL(endpoint);
  const origin = port
    ? `${protocol}//${hostname}:${port}`
    : `${protocol}//${hostname}`;

  execFileSync("security", [
    "add-generic-password",
    "-U",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    `${providerId}/${name}`,
    "-w",
    JSON.stringify({ value, origin }),
  ]);

  const readback = JSON.parse(
    execFileSync(
      "security",
      [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        `${providerId}/${name}`,
        "-w",
      ],
      { encoding: "utf8" }
    ).trim()
  );

  if (readback.value !== value || readback.origin !== origin) {
    throw new Error(
      `The keychain did not take ${providerId}/${name}; the app would report a missing key.`
    );
  }

  return origin;
};
```

- [ ] **Step 3: Store the key and stop writing it to localStorage**

Replace the selected-provider payload construction (around `scripts/set-stt-provider.mjs:155`) so the variables map holds configuration only:

```js
const endpoint = endpointOf(provider.curl, { MODEL: model });
const origin = storeSecret(provider.id, "API_KEY", apiKey, endpoint);
console.log(`stored API_KEY for ${provider.id}, bound to ${origin}`);

const selected = {
  provider,
  variables: { model },
};
```

`endpointOf` is the script's own local derivation of the provider URL; if the script does not already have one, substitute the non-secret variables into the template's URL with the same brace-restoring `%7B%7B` fix documented in `src/lib/functions/stt.function.ts:88-97`, and fail loudly if the result is not `http(s)`.

Update the report line (`:119-121`) so it no longer implies the map holds a credential:

```js
console.log(`variables: ${Object.keys(parsed.variables ?? {}).join(", ")} (no credential; that is in the keychain)`);
```

- [ ] **Step 4: Verify end to end**

Run: `cd /Users/tessaro/omni && node scripts/set-stt-provider.mjs --provider gemini-stt --model gemini-2.5-flash`
Expected: it reports `stored API_KEY for gemini-stt, bound to https://generativelanguage.googleapis.com`.

Then:

```bash
security find-generic-password -s com.connortessaro.omni -a "gemini-stt/API_KEY" -w
```

Expected: the `{"value":...,"origin":...}` JSON.

Re-run the sqlite reader from Task 7 Step 7. Expected: `curl_selected_stt_provider` holds `model` and no key.

Finally, launch the app and record a voice input. It must transcribe, which proves Rust found the row this script wrote.

- [ ] **Step 5: Confirm the gates**

Run: `cd /Users/tessaro/omni && npm run check:secrets && npm run eval:test`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/set-stt-provider.mjs
git commit -m "fix(scripts): select an STT provider without planting a plaintext key"
```

---

## Closing out

- [ ] **Tick the acceptance criteria** in `backlog/tasks/task-1 - Finish-the-secret-migration-move-keys-out-of-localStorage.md` and set `status: Done`. Each AC maps to one task: #1 → Task 3, #2 → Task 4, #3 → Task 6, #4 → Task 7, #5 → Task 8.
- [ ] **Update `.claude/HANDOFF.md`**: TASK-1 moves out of "Open". Record what was decided, in the file's existing style — that multipart lives in Rust because the body would otherwise have to be a String and audio is not UTF-8; that model listing depends on every entry in `MODEL_LIST_SOURCES` sharing an origin with its chat endpoint, and that a test now enforces it; and that `scripts/set-stt-provider.mjs` writes the keychain with `security add-generic-password`.
- [ ] **Run the full local gate set once more**, plus the two probes that need a dev server:

```bash
cd /Users/tessaro/omni
npx tsc --noEmit && npm run eval:typecheck && npm run check:commands \
  && npm run check:secrets && npm run eval:test && npm run eval:dry-run && npm run build
cd src-tauri && cargo test && cargo check --all-targets
```

Then, with `npm run dev` in one shell, `npm run hud:probe`; and with `npm run dev:harness` in one shell, `npm run ttft:probe`.

- [ ] **Open the PR** and confirm all 8 CI jobs pass, including the new secrets gate.

---

## Self-Review

**Spec coverage.** Every acceptance criterion has a task, listed under "Closing out". Two requirements the spec implies but does not state are covered too: Task 1 supplies the multipart transport the spec names as the reason STT was skipped, and Task 5 fixes the pre-flight validation that would otherwise turn AC #4 into a total chat outage. Task 9 closes a leak the spec does not mention at all — `scripts/set-stt-provider.mjs` re-plants a plaintext key on every run, so without it AC #5 holds only until the next time that script is used.

**Placeholders.** No step defers work. Every code step carries the code, every test step carries the assertions, and every run step names the command and the expected result. The one judgement call left to the executor is `endpointOf` in Task 9 Step 3, which is conditional on whether the script already has a URL derivation; the fallback behaviour and the trap to avoid are both stated.

**Type consistency.** `RequestUpload` is `dataBase64`/`field`/`fileName`/`mimeType`/`fields` in TypeScript (Task 2) and `data_base64`/`field`/`file_name`/`mime_type`/`fields` in Rust under `#[serde(rename_all = "camelCase")]` (Task 1) — the same wire shape, and Task 1's `an_upload_deserializes_from_camel_case` test pins it. `secretExists(providerId, name)` has the same two-argument shape in `transport.ts`, `node-transport.mjs` and `stubs/transport.ts`, and Task 2's export-surface test fails if any of the three drifts. `migrateProviderSecrets` changes return type in Task 7, and its only caller changes in the same task.

**One risk worth stating.** The origin-parity test in Task 3 asserts a property of the provider table rather than of the code, so it will fail the day someone adds a provider whose model-list endpoint sits on a different host from its chat endpoint. That is the intended behaviour: such a provider cannot list models under origin binding, and finding out from a test beats finding out from a 401 that reads like a bad key.
