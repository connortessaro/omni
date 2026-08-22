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
