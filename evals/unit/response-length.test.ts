import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrcModule } from "../harness/loadSrcModule.ts";
import {
  createCapturingFetch,
  installMemoryLocalStorage,
} from "../harness/fakeGlobals.ts";
import { loadAiProviders } from "../harness/providerConfig.ts";
import type { FetchAIResponseParams } from "../harness/runTask.ts";

// Why this exists.
//
// The whole base system prompt was one sentence, and the "short" response-length
// setting appended "Limit your answer to 2-4 sentences maximum ... This is a
// strict requirement" to it verbatim. Ask for a multi-file diff with that setting
// on and the model obeys: it truncates the code, or describes it instead of
// emitting it, and nothing in the product records that a setting did that.
//
// A length limit is a limit on prose. These tests hold that line in two places:
// the constant text itself, and the request body that actually leaves the app.

interface AiModule {
  fetchAIResponse(params: FetchAIResponseParams): AsyncIterable<string>;
}

const { fetchAIResponse } = await loadSrcModule<AiModule>(
  "lib/functions/ai-response.function.ts"
);

interface ResponseSettingsModule {
  RESPONSE_LENGTHS: Array<{ id: string; prompt: string }>;
}

const { RESPONSE_LENGTHS } = await loadSrcModule<ResponseSettingsModule>(
  "lib/response-settings.constants.ts"
);

const providers = await loadAiProviders();
const provider = providers.find((candidate) => candidate.id === "openai");
assert.ok(provider, "expected the shipped openai provider");

const selectedProvider = {
  provider: "openai",
  variables: { api_key: "test-key", model: "gpt-4o-mini" },
};

export const sendAndCaptureBody = async (
  responseLength: string,
  extra: Partial<FetchAIResponseParams> = {}
): Promise<string> => {
  installMemoryLocalStorage({
    response_settings: JSON.stringify({
      responseLength,
      language: "english",
      autoScroll: true,
    }),
  });

  const capturing = createCapturingFetch();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = capturing.fetch;
  try {
    for await (const _chunk of fetchAIResponse({
      provider,
      selectedProvider,
      systemPrompt: "You are a helpful AI assistant.",
      history: [],
      userMessage: "write a function that reverses a linked list",
      imagesBase64: [],
      ...extra,
    })) {
      // Drained so the generator runs to completion.
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(capturing.calls.length, 1, "expected exactly one request");
  return capturing.calls[0].bodyText ?? "";
};

const CODE_CARVE_OUT = "never shorten, truncate, elide, or summarise code";

test("every response-length option carves code out of its limit", () => {
  for (const option of RESPONSE_LENGTHS) {
    assert.ok(
      option.prompt.includes(CODE_CARVE_OUT),
      `the "${option.id}" prompt must exempt code from its length limit`
    );
  }
});

test("the short setting still limits prose", async () => {
  const body = await sendAndCaptureBody("short");
  assert.ok(
    body.includes("2-4 sentences"),
    "short must still constrain prose length"
  );
});

test("the short setting reaches the provider with the code carve-out attached", async () => {
  const body = await sendAndCaptureBody("short");
  assert.ok(
    body.includes(JSON.stringify(CODE_CARVE_OUT).slice(1, -1)),
    "the carve-out must survive into the request body, not just the constant"
  );
});

test("a code turn drops the length instruction entirely", async () => {
  const body = await sendAndCaptureBody("short", { codeIntent: true });
  assert.ok(
    !body.includes("2-4 sentences"),
    "an explicit code turn must not carry a prose sentence cap at all"
  );
});

test("a code turn keeps the language instruction", async () => {
  // codeIntent suppresses the length limit only. Dropping the language choice
  // with it would answer a Spanish user in English because they asked for a diff.
  installMemoryLocalStorage({
    response_settings: JSON.stringify({
      responseLength: "short",
      language: "spanish",
      autoScroll: true,
    }),
  });
  const capturing = createCapturingFetch();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = capturing.fetch;
  try {
    for await (const _chunk of fetchAIResponse({
      provider,
      selectedProvider,
      systemPrompt: "You are a helpful AI assistant.",
      history: [],
      userMessage: "write a function that reverses a linked list",
      imagesBase64: [],
      codeIntent: true,
    })) {
      // Drained so the generator runs to completion.
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  const body = capturing.calls[0]?.bodyText ?? "";
  assert.ok(
    body.includes("Respond in Spanish"),
    "language must survive a code turn"
  );
  assert.ok(
    !body.includes("2-4 sentences"),
    "the length cap must not survive a code turn"
  );
});
