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
