import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * The single place the app reaches a provider.
 *
 * Rust issues the request so credentials never enter the webview: the caller
 * leaves `{{OMNI_SECRET:NAME}}` where a secret belongs and Rust substitutes it,
 * only when the request is going to the origin that secret is bound to.
 *
 * One module on purpose. It is the seam the test harness replaces, so there is
 * exactly one thing to stub rather than an `invoke` call in every request path.
 */

export const secretPlaceholder = (name: string): string =>
  `{{OMNI_SECRET:${name}}}`;

/** Variable names treated as credentials rather than plain configuration. */
const SECRET_NAME_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

export const isSecretVariable = (name: string): boolean =>
  SECRET_NAME_PATTERN.test(name);

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

export interface ProviderRequestParams {
  providerId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  upload?: RequestUpload;
  signal?: AbortSignal;
}

const nextRequestId = (): string =>
  `preq_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

export async function* streamProviderRequest({
  providerId,
  url,
  method,
  headers,
  body,
  upload,
  signal,
}: ProviderRequestParams): AsyncIterable<string> {
  const requestId = nextRequestId();

  // Chunks arrive on a channel callback, which has to be adapted into something
  // a `for await` can consume.
  const pending: string[] = [];
  let notify: (() => void) | null = null;
  let finished = false;
  let failure: Error | null = null;

  const wake = () => {
    notify?.();
    notify = null;
  };

  const channel = new Channel<string>();
  channel.onmessage = (chunk) => {
    pending.push(chunk);
    wake();
  };

  const onAbort = () => {
    void invoke("provider_request_cancel", { requestId }).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const completed = invoke("provider_request", {
    request: { requestId, providerId, url, method, headers, body, upload },
    onChunk: channel,
  })
    .catch((error: unknown) => {
      failure = error instanceof Error ? error : new Error(String(error));
    })
    .finally(() => {
      finished = true;
      wake();
    });

  try {
    while (true) {
      while (pending.length > 0) {
        if (signal?.aborted) return;
        yield pending.shift() as string;
      }
      if (finished) break;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }

    await completed;
    if (failure) throw failure;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
