// Covers model listing: the parsers, the auth style each provider needs, and
// the filtering that keeps non-chat models out of a chat model picker.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSrcModule } from "../harness/loadSrcModule.ts";
import { installMemoryLocalStorage } from "../harness/fakeGlobals.ts";
import { lastRequest, replyWith, reset, setResponder } from "./stubs/plugin-http.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

interface ModelsModule {
  listModels: (params: {
    providerId: string;
    variables: Record<string, string>;
    curl?: string;
  }) => Promise<string[]>;
  readCachedModels: (providerId: string) => string[] | null;
  writeCachedModels: (providerId: string, models: string[]) => void;
}

installMemoryLocalStorage();

const { listModels, readCachedModels, writeCachedModels } =
  await loadSrcModule<ModelsModule>("lib/functions/models.function.ts", {
    alias: {
      "@tauri-apps/plugin-http": join(HERE, "stubs", "plugin-http.ts"),
    },
  });

const openAiShape = (...ids: string[]) => ({
  object: "list",
  data: ids.map((id) => ({ id, object: "model" })),
});

beforeEach(() => reset());

test("openai-shaped responses yield model ids", async () => {
  replyWith(openAiShape("gpt-4o-mini", "gpt-4o"));
  const models = await listModels({
    providerId: "openai",
    variables: { API_KEY: "sk-test" },
  });
  assert.deepEqual(models, ["gpt-4o-mini", "gpt-4o"]);
  assert.equal(lastRequest()?.headers.Authorization, "Bearer sk-test");
});

test("gemini ids have their models/ prefix stripped", async () => {
  replyWith(openAiShape("models/gemini-2.5-flash", "models/gemini-2.5-pro"));
  const models = await listModels({
    providerId: "gemini",
    variables: { API_KEY: "AIza-test" },
  });
  assert.deepEqual(models, ["gemini-2.5-flash", "gemini-2.5-pro"]);
  assert.match(lastRequest()?.url ?? "", /\/v1beta\/openai\/models$/);
});

test("anthropic is called with x-api-key and a version header, not bearer", async () => {
  replyWith(openAiShape("claude-sonnet-4-5", "claude-haiku-4-5"));
  await listModels({ providerId: "claude", variables: { API_KEY: "sk-ant" } });

  const request = lastRequest();
  assert.equal(request?.headers["x-api-key"], "sk-ant");
  assert.equal(request?.headers["anthropic-version"], "2023-06-01");
  assert.equal(
    request?.headers.Authorization,
    undefined,
    "anthropic rejects bearer auth on this endpoint"
  );
});

test("cohere's models[].name shape is read", async () => {
  replyWith({ models: [{ name: "command-r" }, { name: "command-r-plus" }] });
  const models = await listModels({
    providerId: "cohere",
    variables: { API_KEY: "co-test" },
  });
  assert.deepEqual(models, ["command-r", "command-r-plus"]);
});

test("openrouter needs no key", async () => {
  replyWith(openAiShape("openai/gpt-4o-mini"));
  const models = await listModels({ providerId: "openrouter", variables: {} });
  assert.deepEqual(models, ["openai/gpt-4o-mini"]);
  assert.equal(lastRequest()?.headers.Authorization, undefined);
});

test("non-chat models are filtered out of the picker", async () => {
  replyWith(
    openAiShape(
      "models/gemini-2.5-flash",
      "models/gemini-2.5-flash-preview-tts",
      "models/text-embedding-004",
      "models/imagen-3.0-generate",
      "models/veo-2.0",
      "models/gemini-2.5-flash-image"
    )
  );
  const models = await listModels({
    providerId: "gemini",
    variables: { API_KEY: "AIza-test" },
  });
  assert.deepEqual(models, ["gemini-2.5-flash"]);
});

test("google's oddly-named image and music models are filtered out", async () => {
  // These advertise generateContent like chat models do, so only the name helps.
  replyWith(
    openAiShape(
      "models/gemini-3.7-flash",
      "models/nano-banana-pro-preview",
      "models/lyria-3-clip-preview"
    )
  );
  const models = await listModels({
    providerId: "gemini",
    variables: { API_KEY: "AIza-test" },
  });
  assert.deepEqual(models, ["gemini-3.7-flash"]);
});

test("a list of only non-chat models is returned rather than swallowed", async () => {
  // Better to show something questionable than an empty picker with no reason.
  replyWith(openAiShape("whisper-1"));
  const models = await listModels({
    providerId: "openai",
    variables: { API_KEY: "sk-test" },
  });
  assert.deepEqual(models, ["whisper-1"]);
});

test("a missing key fails before any request is sent", async () => {
  await assert.rejects(
    () => listModels({ providerId: "openai", variables: {} }),
    /API key/
  );
  assert.equal(lastRequest(), undefined, "no request should have been attempted");
});

test("an http error surfaces the status and the provider's own message", async () => {
  setResponder(() => ({
    status: 401,
    body: { error: { message: "invalid key" } },
    text: '{"error":{"message":"invalid key"}}',
  }));
  await assert.rejects(
    () => listModels({ providerId: "openai", variables: { API_KEY: "bad" } }),
    /401.*invalid key/s
  );
});

test("an empty list is an error, not an empty picker", async () => {
  replyWith(openAiShape());
  await assert.rejects(
    () => listModels({ providerId: "openai", variables: { API_KEY: "sk" } }),
    /no models/
  );
});

test("a custom provider's endpoint is derived from its curl template", async () => {
  replyWith(openAiShape("my-model"));
  const models = await listModels({
    providerId: "my-custom-thing",
    variables: { API_KEY: "k" },
    curl: `curl https://llm.internal/v1/chat/completions -H "Authorization: Bearer {{API_KEY}}" -d '{"model":"{{MODEL}}"}'`,
  });
  assert.deepEqual(models, ["my-model"]);
  assert.equal(lastRequest()?.url, "https://llm.internal/v1/models");
});

test("an unknown provider with no derivable endpoint says so", async () => {
  await assert.rejects(
    () => listModels({ providerId: "mystery", variables: { API_KEY: "k" } }),
    /Dev space/
  );
});

test("the cache round-trips and is scoped per provider", () => {
  writeCachedModels("openai", ["gpt-4o"]);
  writeCachedModels("gemini", ["gemini-2.5-flash"]);
  assert.deepEqual(readCachedModels("openai"), ["gpt-4o"]);
  assert.deepEqual(readCachedModels("gemini"), ["gemini-2.5-flash"]);
  assert.equal(readCachedModels("groq"), null);
});

test("a stale cache entry is ignored", () => {
  const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
  globalThis.localStorage!.setItem(
    "omni_models_openai",
    JSON.stringify({ models: ["ancient"], fetchedAt: twoDaysAgo })
  );
  assert.equal(readCachedModels("openai"), null);
});

test("a corrupt cache entry does not throw", () => {
  globalThis.localStorage!.setItem("omni_models_openai", "{not json");
  assert.equal(readCachedModels("openai"), null);
});
