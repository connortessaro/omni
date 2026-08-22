// Covers the three body shapes the ten templates in stt.constants.ts need, and
// the one invariant that spans all of them: the credential is a placeholder.
//
// The audio itself cannot be a String, which is why these go through the
// transport's `upload` rather than its `body`. Getting the shape wrong is a
// silent failure: a multipart field under the wrong name reads back as "no
// audio provided", and a raw-binary provider handed a form reads back as a
// corrupt file.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSrcModule } from "../harness/loadSrcModule.ts";
import { installFileReader } from "../harness/fakeGlobals.ts";
import { lastRequest, replyWith, reset } from "./stubs/transport.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRANSPORT_STUB = join(HERE, "stubs", "transport.ts");

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
    curl: string;
    responseContentPath: string;
  }[];
}

installFileReader();

const { fetchSTT } = await loadSrcModule<SttModule>(
  "lib/functions/stt.function.ts",
  { transport: TRANSPORT_STUB }
);
const { SPEECH_TO_TEXT_PROVIDERS } = await loadSrcModule<SttConstantsModule>(
  "config/stt.constants.ts"
);

const providerNamed = (id: string) => {
  const provider = SPEECH_TO_TEXT_PROVIDERS.find((p) => p.id === id);
  assert.ok(provider, `${id} must be registered in stt.constants.ts`);
  return provider;
};

const audio = () => new Blob(["fake-wav"], { type: "audio/wav" });
const AUDIO_BASE64 = Buffer.from("fake-wav").toString("base64");

beforeEach(() => reset());

const transcribe = (id: string, replyBody: unknown) => {
  replyWith(replyBody);
  return fetchSTT({
    provider: providerNamed(id),
    selectedProvider: {
      provider: id,
      variables: { api_key: "sk-should-be-ignored", model: "whisper-1" },
    },
    audio: audio(),
  });
};

test("a -F provider uploads multipart with its own text fields", async () => {
  const text = await transcribe("openai-whisper", { text: "hello there" });
  assert.equal(text, "hello there");

  const upload = lastRequest()?.upload;
  assert.equal(upload?.field, "file");
  assert.equal(upload?.dataBase64, AUDIO_BASE64);
  assert.equal(upload?.mimeType, "audio/wav");
  assert.equal(upload?.fileName, "audio.wav");
  assert.equal(upload?.fields?.model, "whisper-1");
  assert.equal(
    lastRequest()?.body,
    undefined,
    "a multipart request has no text body"
  );
});

test("a -F provider's non-file fields all survive", async () => {
  await transcribe("groq", { text: "hi" });

  const fields = lastRequest()?.upload?.fields ?? {};
  assert.equal(fields.model, "whisper-1");
  assert.equal(fields.temperature, "0");
  assert.equal(fields.response_format, "text");
  assert.equal(fields.language, "en");
});

test("the multipart file field is the one the template names, not always 'file'", async () => {
  // speechmatics wants data_file and rev.ai wants media. Hardcoding "file"
  // uploads under a name they ignore, and the error reads like a missing file.
  await transcribe("speechmatics-stt", { job: { id: "job-1" } });
  assert.equal(lastRequest()?.upload?.field, "data_file");

  await transcribe("rev-ai-stt", { id: "job-2" });
  assert.equal(lastRequest()?.upload?.field, "media");
});

test("a --data-binary provider sends the bytes as the whole body", async () => {
  await transcribe("deepgram-stt", {
    results: { channels: [{ alternatives: [{ transcript: "raw bytes" }] }] },
  });

  const upload = lastRequest()?.upload;
  assert.equal(upload?.field, undefined, "a raw body has no multipart field");
  assert.equal(upload?.dataBase64, AUDIO_BASE64);
  assert.equal(lastRequest()?.headers["Content-Type"], "audio/wav");
});

test("a JSON provider inlines base64 in the body and sends no upload", async () => {
  await transcribe("gemini-stt", {
    candidates: [{ content: { parts: [{ text: "inline" }] } }],
  });

  const request = lastRequest();
  assert.equal(request?.upload, undefined);
  const body = JSON.parse(request?.body ?? "{}");
  assert.equal(body.contents[0].parts[1].inline_data.data, AUDIO_BASE64);
});

test("no template's request carries the literal key, in any shape", async () => {
  for (const provider of SPEECH_TO_TEXT_PROVIDERS) {
    reset();
    // The reply is the default `{}`, so most of these reject on a missing
    // transcription. What is under test is what went out, not what came back.
    await fetchSTT({
      provider,
      selectedProvider: {
        provider: provider.id,
        variables: {
          api_key: "sk-should-be-ignored",
          model: "m",
          region: "eastus",
          project_id: "p",
          options: "{}",
        },
      },
      audio: audio(),
    }).catch(() => "");

    const serialized = JSON.stringify(lastRequest());
    assert.doesNotMatch(
      serialized,
      /sk-should-be-ignored/,
      `${provider.id} put the literal key in its request`
    );
    assert.match(
      serialized,
      /\{\{OMNI_SECRET:API_KEY\}\}/,
      `${provider.id} sent no placeholder, so Rust has nothing to substitute`
    );
  }
});

test("the placeholder ships even when the variables map holds no secret", async () => {
  // The end state after the migration: the map carries configuration only. If
  // the placeholder were seeded from the map rather than from the template, the
  // literal {{API_KEY}} would go out and the provider would answer 401.
  replyWith({ text: "still authenticated" });
  const text = await fetchSTT({
    provider: providerNamed("openai-whisper"),
    selectedProvider: {
      provider: "openai-whisper",
      variables: { model: "whisper-1" },
    },
    audio: audio(),
  });

  assert.equal(text, "still authenticated");
  assert.equal(
    lastRequest()?.headers.Authorization,
    "Bearer {{OMNI_SECRET:API_KEY}}"
  );
});

test("the request is attributed to the provider so Rust finds the right account", async () => {
  await transcribe("openai-whisper", { text: "x" });
  assert.equal(lastRequest()?.providerId, "openai-whisper");
});
