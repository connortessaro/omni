// The migration deletes the key from localStorage, so the pre-flight check in
// fetchAIResponse can no longer read it. If that check keeps treating a secret
// like any other variable, every chat request fails with "Missing required
// variable: API_KEY" — the credential is present, just not where this code was
// looking.
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

interface AiResponseModule {
  fetchAIResponse(params: {
    provider: {
      id: string;
      curl: string;
      responseContentPath?: string;
      streaming?: boolean;
    };
    selectedProvider: { provider: string; variables: Record<string, string> };
    userMessage: string;
  }): AsyncIterable<string>;
}

installMemoryLocalStorage();

const { fetchAIResponse } = await loadSrcModule<AiResponseModule>(
  "lib/functions/ai-response.function.ts",
  { transport: TRANSPORT_STUB }
);

const provider = {
  id: "openai",
  curl: `curl https://api.openai.com/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {{API_KEY}}" \\
  -d '{
    "model": "{{MODEL}}",
    "messages": [{"role": "system", "content": "{{SYSTEM_PROMPT}}"}, {"role": "user", "content": "{{TEXT}}"}],
    "stream": false
  }'`,
  responseContentPath: "choices[0].message.content",
  streaming: false,
};

const drain = async (variables: Record<string, string>): Promise<string> => {
  let text = "";
  for await (const chunk of fetchAIResponse({
    provider,
    selectedProvider: { provider: "openai", variables },
    userMessage: "hello",
  })) {
    text += chunk;
  }
  return text;
};

beforeEach(() => reset());

test("a request goes out with no key in the variables map", async () => {
  replyWith({ choices: [{ message: { content: "hi" } }] });
  const answer = await drain({ model: "gpt-4o-mini" });

  assert.equal(answer, "hi");
  assert.equal(
    lastRequest()?.headers.Authorization,
    "Bearer {{OMNI_SECRET:API_KEY}}"
  );
});

test("a non-secret variable that is still missing is reported", async () => {
  // model has no credential store to fall back on, so this check has to keep
  // working for everything that is not a secret. extractVariables reports the
  // name lower-cased, which is also how the variables map is keyed.
  await assert.rejects(() => drain({}), /Missing required variable: model/);
});

test("no stored credential is reported before a request is issued", async () => {
  setSecretExists(false);
  await assert.rejects(
    () => drain({ model: "gpt-4o-mini" }),
    /API_KEY/,
    "the error must name the credential so the user knows what to add"
  );
  assert.equal(
    lastRequest(),
    undefined,
    "a keyless request is a guaranteed 401"
  );
});
