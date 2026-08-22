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

type AuthStyle = "bearer" | "x-api-key" | "none";

interface ModelListSource {
  url: string;
  auth: AuthStyle;
  /** Property holding the array of models in the response. */
  arrayKey: string;
  /** Property holding the model id on each entry. */
  idKey: string;
  headers?: Record<string, string>;
  /** Gemini's OpenAI-compatible endpoint returns ids like `models/gemini-3`. */
  stripPrefix?: string;
}

const OPENAI_SHAPE = { arrayKey: "data", idKey: "id" } as const;

export const MODEL_LIST_SOURCES: Record<string, ModelListSource> = {
  openai: { url: "https://api.openai.com/v1/models", auth: "bearer", ...OPENAI_SHAPE },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    auth: "bearer",
    stripPrefix: "models/",
    ...OPENAI_SHAPE,
  },
  grok: { url: "https://api.x.ai/v1/models", auth: "bearer", ...OPENAI_SHAPE },
  groq: { url: "https://api.groq.com/openai/v1/models", auth: "bearer", ...OPENAI_SHAPE },
  mistral: { url: "https://api.mistral.ai/v1/models", auth: "bearer", ...OPENAI_SHAPE },
  perplexity: { url: "https://api.perplexity.ai/models", auth: "bearer", ...OPENAI_SHAPE },
  openrouter: { url: "https://openrouter.ai/api/v1/models", auth: "none", ...OPENAI_SHAPE },
  claude: {
    url: "https://api.anthropic.com/v1/models",
    auth: "x-api-key",
    headers: { "anthropic-version": "2023-06-01" },
    ...OPENAI_SHAPE,
  },
  cohere: {
    url: "https://api.cohere.ai/v1/models",
    auth: "bearer",
    arrayKey: "models",
    idKey: "name",
  },
  ollama: {
    url: "http://localhost:11434/api/tags",
    auth: "none",
    arrayKey: "models",
    idKey: "name",
  },
};

/**
 * Model families that cannot answer a chat prompt. Providers return these in the
 * same list as chat models, and offering them would produce a confusing failure
 * at request time rather than at selection time.
 *
 * Name matching is the only signal available. Filtering on the provider's own
 * declared capabilities was tried and rejected: Gemini's image and music models
 * (nano-banana, lyria) advertise `generateContent` exactly like its chat models,
 * so the capability field does not discriminate. The filter is therefore
 * best-effort, and `listModels` returns the unfiltered list rather than an empty
 * picker if it would remove everything.
 */
const NON_CHAT_MARKERS = [
  "embedding",
  "embed-",
  "-tts",
  "tts-",
  "whisper",
  "dall-e",
  "imagen",
  "veo-",
  "moderation",
  "rerank",
  "-image",
  "image-",
  "aqa",
  "-audio",
  "transcribe",
  "realtime",
  "guard",
  // Google product lines that are not chat models despite the generic naming.
  "nano-banana",
  "lyria",
];

const isChatModel = (id: string): boolean => {
  const lowered = id.toLowerCase();
  return !NON_CHAT_MARKERS.some((marker) => lowered.includes(marker));
};

/**
 * Custom providers are user-pasted curl templates, so there is no table entry.
 * Sibling `/models` next to the chat endpoint is the near-universal convention.
 */
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

  const withoutQuery = url.split("?")[0].replace(/\/+$/, "");
  const chatSuffix = withoutQuery.match(/\/(chat\/completions|messages|chat)$/);
  if (!chatSuffix) return null;

  return {
    url: `${withoutQuery.slice(0, -chatSuffix[0].length)}/models`,
    auth: "bearer",
    ...OPENAI_SHAPE,
  };
};

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

const readIds = (payload: unknown, source: ModelListSource): string[] => {
  const container = payload as Record<string, unknown> | null;
  const entries = container?.[source.arrayKey];
  if (!Array.isArray(entries)) return [];

  return entries
    .map((entry) => {
      const id = (entry as Record<string, unknown>)?.[source.idKey];
      if (typeof id !== "string") return null;
      return source.stripPrefix && id.startsWith(source.stripPrefix)
        ? id.slice(source.stripPrefix.length)
        : id;
    })
    .filter((id): id is string => Boolean(id));
};

export interface ListModelsParams {
  providerId: string;
  /** The provider's configured variables, including its api key. */
  variables: Record<string, string>;
  /** The provider's curl template, used to derive an endpoint for custom providers. */
  curl?: string;
  signal?: AbortSignal;
}

/** Throws with a message worth showing the user; callers should surface it. */
export async function listModels({
  providerId,
  variables,
  curl,
  signal,
}: ListModelsParams): Promise<string[]> {
  const source =
    MODEL_LIST_SOURCES[providerId] ??
    (curl ? deriveSourceFromCurl(curl, variables) : null);

  if (!source) {
    throw new Error(
      `Cannot list models for "${providerId}". Set the model by hand in Dev space.`
    );
  }

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
  if (ids.length === 0) {
    throw new Error(`${providerId} returned no models.`);
  }

  const chatModels = ids.filter(isChatModel);
  return chatModels.length > 0 ? chatModels : ids;
}

const CACHE_PREFIX = "omni_models_";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedModels {
  models: string[];
  fetchedAt: number;
}

export const readCachedModels = (providerId: string): string[] | null => {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${providerId}`);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedModels;
    if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) return null;
    return Array.isArray(cached.models) ? cached.models : null;
  } catch {
    return null;
  }
};

export const writeCachedModels = (providerId: string, models: string[]): void => {
  try {
    const payload: CachedModels = { models, fetchedAt: Date.now() };
    localStorage.setItem(`${CACHE_PREFIX}${providerId}`, JSON.stringify(payload));
  } catch {
    // A full or unavailable localStorage should not break model switching.
  }
};
