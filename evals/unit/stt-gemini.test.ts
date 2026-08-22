import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrcModule } from "../harness/loadSrcModule.ts";
import { installFileReader } from "../harness/fakeGlobals.ts";

// Why this exists.
//
// The Gemini STT provider reuses the chat key, so it is the one speech provider
// a Gemini-only user can turn on without signing up for anything. It reaches the
// model through generateContent with inline audio, which means two things have
// to hold that no other provider in stt.constants.ts depends on:
//
//   1. `mime_type` has to describe the bytes actually being sent. The two
//      recorders disagree — system audio is WAV (useSystemAudio.ts), the mic
//      goes through WKWebView's MediaRecorder and comes out audio/mp4
//      (AudioRecorder.tsx) — so the template cannot hardcode it and fetchSTT
//      has to supply it.
//   2. The transcript has to be readable at `candidates[0].content.parts[0]
//      .text`. Thinking is budgeted to zero in the template precisely so a
//      thought part cannot take that slot.
//
// Both are silent failures if they regress: a wrong mime_type gets a 400 that
// reads like a bad key, and a shifted part path returns empty and surfaces as
// "did not contain a transcription".

interface SttModule {
  fetchSTT(params: {
    provider: { curl: string; responseContentPath?: string } | undefined;
    selectedProvider: { provider: string; variables: Record<string, string> };
    audio: File | Blob;
  }): Promise<string>;
}

interface SttConstantsModule {
  SPEECH_TO_TEXT_PROVIDERS: {
    id: string;
    name: string;
    curl: string;
    responseContentPath: string;
  }[];
}

installFileReader();

const { fetchSTT } = await loadSrcModule<SttModule>(
  "lib/functions/stt.function.ts"
);
const { SPEECH_TO_TEXT_PROVIDERS } = await loadSrcModule<SttConstantsModule>(
  "config/stt.constants.ts"
);

const gemini = SPEECH_TO_TEXT_PROVIDERS.find((p) => p.id === "gemini-stt");

/** A canned generateContent reply shaped like the real one. */
const transcriptResponse = (text: string) =>
  JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
  });

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

/** Runs fetchSTT against a stubbed network and returns what it assembled. */
async function transcribe(
  audio: Blob,
  responseBody = transcriptResponse("hello there")
): Promise<{ result: string; sent: Captured }> {
  assert.ok(gemini, "the gemini-stt provider must be registered");

  let sent: Captured | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent = {
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body)),
    };
    return new Response(responseBody, { status: 200 });
  }) as typeof fetch;

  try {
    const result = await fetchSTT({
      provider: gemini,
      selectedProvider: {
        provider: "gemini-stt",
        variables: { api_key: "test-key", model: "gemini-2.5-flash" },
      },
      audio,
    });
    assert.ok(sent, "fetchSTT must have issued a request");
    return { result, sent };
  } finally {
    globalThis.fetch = original;
  }
}

test("the model and key land in the URL and headers, not the body", async () => {
  const { sent } = await transcribe(new Blob(["fake-wav"], { type: "audio/wav" }));

  assert.match(sent.url, /models\/gemini-2\.5-flash:generateContent/);
  assert.equal(sent.headers["x-goog-api-key"], "test-key");
  assert.doesNotMatch(
    JSON.stringify(sent.body),
    /test-key/,
    "the key must not be duplicated into the request body"
  );
});

test("system audio is declared as WAV", async () => {
  const { sent } = await transcribe(new Blob(["fake-wav"], { type: "audio/wav" }));

  const inline = sent.body.contents[0].parts[1].inline_data;
  assert.equal(inline.mime_type, "audio/wav");
  assert.equal(inline.data, Buffer.from("fake-wav").toString("base64"));
});

test("mic audio is declared as what MediaRecorder produced, not WAV", async () => {
  // The regression this guards: hardcoding audio/wav in the template. The mic
  // path never produces WAV, so every voice input would 400.
  const { sent } = await transcribe(new Blob(["fake-mp4"], { type: "audio/mp4" }));

  assert.equal(sent.body.contents[0].parts[1].inline_data.mime_type, "audio/mp4");
});

test("a codec parameter is stripped from the declared type", async () => {
  // MediaRecorder reports e.g. "audio/mp4;codecs=mp4a.40.2"; Gemini rejects the
  // parameterised form.
  const { sent } = await transcribe(
    new Blob(["fake"], { type: "audio/mp4;codecs=mp4a.40.2" })
  );

  assert.equal(sent.body.contents[0].parts[1].inline_data.mime_type, "audio/mp4");
});

test("thinking is budgeted to zero so the transcript stays at parts[0]", async () => {
  const { sent } = await transcribe(new Blob(["fake"], { type: "audio/wav" }));

  assert.equal(sent.body.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(sent.body.generationConfig.temperature, 0);
});

test("the transcript is read out of the candidate part", async () => {
  const { result } = await transcribe(
    new Blob(["fake"], { type: "audio/wav" }),
    transcriptResponse("  The quick brown fox.  ")
  );

  assert.equal(result, "The quick brown fox.");
});

test("an empty candidate is an error, not a silent blank transcription", async () => {
  await assert.rejects(
    () =>
      transcribe(
        new Blob(["fake"], { type: "audio/wav" }),
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "" }] } }] })
      ),
    /did not contain a transcription/
  );
});
