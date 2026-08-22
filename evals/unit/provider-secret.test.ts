// A stored secret is bound to an origin, and that origin comes from the
// provider's own curl. Deriving it with the secret still substituted would put
// the key in the origin for providers that authenticate in the query string,
// which is the leak this whole change exists to close.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrcModule } from "../harness/loadSrcModule.ts";

interface MigrationModule {
  endpointFor(curl: string, variables: Record<string, string>): string | null;
}

const { endpointFor } = await loadSrcModule<MigrationModule>(
  "lib/functions/secret-migration.ts"
);

test("an endpoint is read out of the curl template", () => {
  assert.equal(
    endpointFor(
      'curl -X POST "https://api.openai.com/v1/chat/completions" -H "Authorization: Bearer {{API_KEY}}"',
      {}
    ),
    "https://api.openai.com/v1/chat/completions"
  );
});

test("a non-secret variable in the path is substituted", () => {
  assert.equal(
    endpointFor(
      'curl -X POST "https://{{REGION}}.stt.speech.microsoft.com/speech/recognition"',
      { REGION: "eastus" }
    ),
    "https://eastus.stt.speech.microsoft.com/speech/recognition"
  );
});

test("a template with no usable url yields null rather than a guess", () => {
  assert.equal(endpointFor("curl --help", {}), null);
  assert.equal(endpointFor('curl "not a url"', {}), null);
});
