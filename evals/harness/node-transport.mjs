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

export async function* streamProviderRequest({
  url,
  method,
  headers,
  body,
  signal,
}) {
  const injectedHeaders = Object.fromEntries(
    Object.entries(headers ?? {}).map(([name, value]) => [
      name,
      injectSecrets(value),
    ])
  );

  const response = await globalThis.fetch(injectSecrets(url), {
    method,
    headers: injectedHeaders,
    body: body === undefined ? undefined : injectSecrets(body),
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
