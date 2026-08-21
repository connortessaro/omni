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
// Reading code off a screenshot is accurate to about 1.5% of characters. That
// sounds fine until the wrong character is an operator. Given a screenshot of
// `if !matches!(parsed.scheme(), "http" | "https")`, the model dropped the `!`,
// concluded the function rejected http and https, and recommended deleting the
// check, which is the guard that stops a secret being sent to a file:// URL. The
// answer was fluent, cited line numbers, and was wrong in a way nothing in the
// product could catch.
//
// Asked to quote the line verbatim first, the same model on the same screenshot
// read the `!` and described the behaviour correctly. So the instruction is only
// added when an image is attached: it costs nothing on a text-only turn and it turns
// a silent misreading into a quote the user can check.

interface AiModule {
  fetchAIResponse(params: FetchAIResponseParams): AsyncIterable<string>;
  IMAGE_GROUNDING_INSTRUCTIONS: string;
}

const { fetchAIResponse, IMAGE_GROUNDING_INSTRUCTIONS } =
  await loadSrcModule<AiModule>("lib/functions/ai-response.function.ts");

const providers = await loadAiProviders();
const provider = providers.find((candidate) => candidate.id === "openai");
assert.ok(provider, "expected the shipped openai provider");

const selectedProvider = {
  provider: "openai",
  variables: { api_key: "test-key", model: "gpt-4o-mini" },
};

const sendAndCaptureBody = async (
  imagesBase64: string[]
): Promise<string> => {
  installMemoryLocalStorage({
    response_settings: JSON.stringify({
      responseLength: "auto",
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
      userMessage: "what does this function do?",
      imagesBase64,
    })) {
      // Drained so the generator runs to completion.
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(capturing.calls.length, 1, "expected exactly one request");
  return capturing.calls[0].bodyText ?? "";
};

test("an attached image adds the verbatim-quote instruction", async () => {
  const body = await sendAndCaptureBody(["ZmFrZS1pbWFnZQ=="]);
  assert.ok(
    body.includes("quote"),
    "the system prompt should tell the model to quote what it reads"
  );
  assert.ok(
    body.includes(JSON.stringify(IMAGE_GROUNDING_INSTRUCTIONS).slice(1, -1)),
    "the exact instruction should be in the request"
  );
});

test("a text-only turn does not pay for it", async () => {
  const body = await sendAndCaptureBody([]);
  assert.ok(
    !body.includes(JSON.stringify(IMAGE_GROUNDING_INSTRUCTIONS).slice(1, -1)),
    "no image means no image instruction"
  );
});

test("the instruction asks for unreadable parts to be named", async () => {
  // The other measured failure: on a full-screen capture the model transcribes
  // about 60% of the visible code and stops, with no indication that it did.
  assert.match(IMAGE_GROUNDING_INSTRUCTIONS, /cannot read|unreadable/i);
});
