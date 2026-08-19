// Stands in for @tauri-apps/plugin-http. Records requests and replies with
// scripted payloads, so the real model-listing code can be exercised without
// network access or a key.
//
// State lives on globalThis for the same reason as the plugin-sql stub: esbuild
// inlines this file into the bundle under test, so a test script's own import is
// a separate module instance.

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  method?: string;
}

interface Reply {
  status: number;
  body: unknown;
  text?: string;
}

type Responder = (url: string) => Reply;

interface HttpStubStore {
  requests: RecordedRequest[];
  responder: Responder;
}

const STORE_KEY = "__omniHttpStub__";

const store: HttpStubStore = ((globalThis as Record<string, unknown>)[
  STORE_KEY
] ??= {
  requests: [],
  responder: () => ({ status: 200, body: {} }),
}) as HttpStubStore;

export const requests = store.requests;

export const setResponder = (responder: Responder): void => {
  store.responder = responder;
};

export const replyWith = (body: unknown, status = 200): void => {
  store.responder = () => ({ status, body });
};

export const lastRequest = (): RecordedRequest | undefined =>
  store.requests[store.requests.length - 1];

export const reset = (): void => {
  store.requests.length = 0;
  store.responder = () => ({ status: 200, body: {} });
};

export const fetch = async (
  url: string,
  init: { headers?: Record<string, string>; method?: string } = {}
) => {
  store.requests.push({
    url,
    headers: init.headers ?? {},
    method: init.method,
  });

  const reply = store.responder(url);
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    json: async () => reply.body,
    text: async () => reply.text ?? JSON.stringify(reply.body),
  };
};
