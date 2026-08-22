declare global {
  // eslint-disable-next-line no-var
  var localStorage:
    | {
        getItem(key: string): string | null;
        setItem(key: string, value: string): void;
        removeItem(key: string): void;
        clear(): void;
      }
    | undefined;
}

export class MemoryStorage {
  private readonly store = new Map<string, string>();

  constructor(seed?: Record<string, string>) {
    if (seed) {
      for (const [key, value] of Object.entries(seed)) this.store.set(key, value);
    }
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Omni reads response-length/language settings via `localStorage` (see
 * src/lib/storage/response-settings.storage.ts). Node has no `localStorage`
 * global, and `getResponseSettings()` already catches that and falls back to
 * defaults — but that produces noisy console.error output and leaves the
 * eval's "settings" implicit. Installing this shim makes the settings
 * explicit and reproducible instead of relying on a caught exception.
 */
export function installMemoryLocalStorage(seed?: Record<string, string>): void {
  globalThis.localStorage = new MemoryStorage(seed);
  // safeLocalStorage (src/lib/storage/helper.ts) returns early when there is no
  // `window`, so without this every write through it silently no-ops and a test
  // reads back an empty store.
  const global = globalThis as { window?: unknown };
  global.window ??= globalThis;
}

/**
 * `blobToBase64` (src/lib/functions/common.function.ts) encodes inline audio
 * with `FileReader`, which the webview has and Node does not. This is the
 * smallest shim that satisfies it: `readAsDataURL` only, because that is the
 * one method the production path calls.
 */
export function installFileReader(): void {
  class NodeFileReader {
    result: string | null = null;
    onloadend: (() => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;

    readAsDataURL(blob: Blob): void {
      void blob
        .arrayBuffer()
        .then((buffer) => {
          const base64 = Buffer.from(buffer).toString("base64");
          this.result = `data:${blob.type};base64,${base64}`;
          this.onloadend?.();
        })
        .catch((error) => this.onerror?.(error));
    }
  }

  (globalThis as { FileReader?: unknown }).FileReader = NodeFileReader;
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyText?: string;
  bodyJson: unknown;
}

function headersToRecord(headers: RequestInit["headers"]): Record<string, string> {
  const record: Record<string, string> = {};
  if (!headers) return record;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) record[key] = value;
    return record;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) record[key] = value;
  }
  return record;
}

function safeJsonParse(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface CapturingFetchOptions {
  sseChunks?: string[];
  status?: number;
  jsonBody?: unknown;
}

export interface CapturingFetch {
  fetch: typeof fetch;
  calls: CapturedRequest[];
}

/**
 * A drop-in replacement for the global `fetch` that never touches the
 * network: it records the request Omni's real code assembled and returns a
 * canned response so `fetchAIResponse`'s streaming-parse loop still runs
 * end to end. Installed by reassigning `globalThis.fetch` right before
 * calling into the bundled `fetchAIResponse` — no source file is modified.
 */
export function createCapturingFetch(options: CapturingFetchOptions = {}): CapturingFetch {
  const calls: CapturedRequest[] = [];

  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const bodyText = typeof init.body === "string" ? init.body : undefined;
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: headersToRecord(init.headers),
      bodyText,
      bodyJson: safeJsonParse(bodyText),
    });

    const status = options.status ?? 200;
    if (options.jsonBody !== undefined) {
      return new Response(JSON.stringify(options.jsonBody), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    const chunks =
      options.sseChunks ??
      ['data: {"choices":[{"delta":{"content":""}}]}\n\n', "data: [DONE]\n\n"];
    return new Response(chunks.join(""), {
      status,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  return { fetch: fetchImpl, calls };
}
