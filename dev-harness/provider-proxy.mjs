// Stands in for the Rust `provider_request` command so the real UI can hold a
// real conversation while running in a plain browser.
//
// The point of the shipped design is that the webview never holds a credential:
// the frontend leaves `{{OMNI_SECRET:NAME}}` where a key belongs and Rust
// substitutes it at send time (src-tauri/src/secrets.rs). This proxy keeps that
// property in the harness — it holds the key, the page does not — so driving the
// UI in a browser does not quietly undo the thing it is meant to verify.
//
// Usage: node dev-harness/provider-proxy.mjs      (or `npm run dev:live`)
//
// Reads the key from ~/.config/omni/eval.env, the same file the eval runner uses.
// Development only. It is bound to loopback, allows any local origin, and is
// never bundled into the app.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.HARNESS_PROXY_PORT ?? 1422);
const ENV_FILE =
  process.env.OMNI_EVAL_ENV_FILE ?? join(homedir(), ".config/omni/eval.env");

const SECRET_PLACEHOLDER = /\{\{OMNI_SECRET:[A-Za-z0-9_]+\}\}/g;

/** Parses KEY=VALUE lines, ignoring blanks, comments and surrounding quotes. */
const readEnvFile = (path) => {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    out[name] = value;
  }
  return out;
};

const fileEnv = readEnvFile(ENV_FILE);
const API_KEY = process.env.OMNI_EVAL_API_KEY ?? fileEnv.OMNI_EVAL_API_KEY ?? "";

if (!API_KEY) {
  console.error(
    `No OMNI_EVAL_API_KEY found in the environment or ${ENV_FILE}.\n` +
      "The proxy would send requests with an empty credential and every call " +
      "would come back 401, so it is refusing to start instead."
  );
  process.exit(1);
}

/** Mirrors secrets.rs: substitute at send time, never before. */
const injectSecrets = (text) =>
  typeof text === "string" ? text.replace(SECRET_PLACEHOLDER, API_KEY) : text;

/** Some providers authenticate in the query string, so keys reach error text. */
const redact = (text) =>
  API_KEY ? String(text).split(API_KEY).join("<redacted>") : String(text);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * Every request the app makes, with its size. The app itself reports none of
 * this, and "how many bytes did that turn cost" is exactly what a context-window
 * question comes down to.
 */
const stats = [];

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...CORS,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
};

/** Forwards one provider request and streams the response body back verbatim. */
const handleProvider = async (req, res) => {
  let request;
  try {
    request = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { error: `Malformed request: ${error.message}` });
    return;
  }

  const { url, method = "POST", headers = {}, body } = request;
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
    sendJson(res, 400, { error: `Not a usable URL: ${url}` });
    return;
  }

  const injectedHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, injectSecrets(value)])
  );

  const started = Date.now();
  const requestBytes = body ? Buffer.byteLength(body) : 0;

  let upstream;
  try {
    upstream = await fetch(injectSecrets(url), {
      method,
      headers: injectedHeaders,
      body: body === undefined || body === null ? undefined : injectSecrets(body),
    });
  } catch (error) {
    console.error(`  request failed: ${redact(error.message)}`);
    stats.push({
      host: new URL(url).host,
      status: 0,
      requestBytes,
      responseBytes: 0,
      ms: Date.now() - started,
      error: redact(error.message),
    });
    sendJson(res, 502, { error: `Request failed: ${redact(error.message)}` });
    return;
  }

  const entry = {
    host: new URL(url).host,
    status: upstream.status,
    requestBytes,
    responseBytes: 0,
    ms: Date.now() - started,
  };
  stats.push(entry);

  console.log(
    `POST ${entry.host} ${upstream.status} ` +
      `sent=${(requestBytes / 1024).toFixed(1)}KB in ${entry.ms}ms`
  );

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    entry.error = redact(detail).slice(0, 400);
    sendJson(res, upstream.status, {
      error: `Provider returned ${upstream.status}${
        entry.error ? `: ${entry.error}` : ""
      }`,
    });
    return;
  }

  res.writeHead(200, {
    ...CORS,
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });

  if (!upstream.body) {
    res.end(await upstream.text());
    return;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      entry.responseBytes += value.length;
      res.write(Buffer.from(value));
    }
  } catch (error) {
    console.error(`  stream error: ${redact(error.message)}`);
    entry.error = `Stream error: ${redact(error.message)}`;
  } finally {
    entry.ms = Date.now() - started;
    res.end();
  }
};

/**
 * Serves a PNG as base64 so the mocked `capture_to_base64` can return a real
 * screenshot. The app's own capture is a native screen grab that no browser can
 * perform, and the byte size of that grab is one of the things under test.
 */
const handleCapture = (res) => {
  const path = process.env.HARNESS_CAPTURE_PNG;
  if (!path) {
    sendJson(res, 404, {
      error:
        "HARNESS_CAPTURE_PNG is not set, so there is no fixture screenshot to serve.",
    });
    return;
  }
  if (!existsSync(path)) {
    sendJson(res, 404, { error: `No such file: ${path}` });
    return;
  }
  const png = readFileSync(path);
  sendJson(res, 200, {
    base64: png.toString("base64"),
    bytes: png.length,
    path,
  });
};

const server = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const path = new URL(req.url, `http://localhost:${PORT}`).pathname;

  if (path === "/health") {
    sendJson(res, 200, { ok: true, keyConfigured: true });
    return;
  }
  if (path === "/capture" && req.method === "GET") {
    handleCapture(res);
    return;
  }
  if (path === "/stats" && req.method === "GET") {
    sendJson(res, 200, { requests: stats });
    return;
  }
  if (path === "/stats" && req.method === "DELETE") {
    stats.length = 0;
    sendJson(res, 200, { requests: [] });
    return;
  }
  if (path === "/provider" && req.method === "POST") {
    void handleProvider(req, res);
    return;
  }

  sendJson(res, 404, { error: `No handler for ${req.method} ${path}` });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `Harness provider proxy on http://127.0.0.1:${PORT} ` +
      `(key from ${ENV_FILE}, never sent to the page)`
  );
});
