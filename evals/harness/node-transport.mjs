// Stands in for src/lib/functions/transport.ts, whose real implementation calls a
// Tauri command that cannot run outside the app.
//
// It mirrors what Rust does: substitute {{OMNI_SECRET:NAME}} at send time, then
// stream the body. The secret comes from OMNI_EVAL_API_KEY, and the request goes
// through globalThis.fetch, so a script that stubs the global (the dry run) still
// intercepts everything and a live run reaches the network.

export const secretPlaceholder = (name) => `{{OMNI_SECRET:${name}}}`;

export const isSecretVariable = (name) =>
  /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name);

const injectSecrets = (text) => {
  if (typeof text !== "string") return text;
  const secret = process.env.OMNI_EVAL_API_KEY ?? "";
  return text.replace(/\{\{OMNI_SECRET:[A-Za-z0-9_]+\}\}/g, secret);
};

// A live run has a key in the environment; a dry run does not and does not need
// one, because nothing it talks to checks.
export const secretExists = async () => Boolean(process.env.OMNI_EVAL_API_KEY);

// Rust assembles multipart from the base64 upload; here fetch does, so the same
// description has to be turned into a body it understands.
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

export async function* streamProviderRequest({
  url,
  method,
  headers,
  body,
  upload,
  signal,
}) {
  const injectedHeaders = Object.fromEntries(
    Object.entries(headers ?? {}).map(([name, value]) => [
      name,
      injectSecrets(value),
    ])
  );

  // fetch generates the boundary, so it owns Content-Type for multipart.
  if (upload?.field) {
    for (const name of Object.keys(injectedHeaders)) {
      if (name.toLowerCase() === "content-type") delete injectedHeaders[name];
    }
  }

  const response = await globalThis.fetch(injectSecrets(url), {
    method,
    headers: injectedHeaders,
    body: bodyFor(body, upload),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Provider returned ${response.status}${detail ? `: ${detail.slice(0, 400)}` : ""}`
    );
  }

  // The dry run's stub returns a plain string body rather than a stream.
  if (!response.body || typeof response.body.getReader !== "function") {
    yield await response.text();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
}
