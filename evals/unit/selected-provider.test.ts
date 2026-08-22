// The end state the whole task is for: what lands in localStorage carries no
// credential. This is checked here rather than by reading the real
// localstorage.sqlite3, because a unit test runs in CI and a keychain does not.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadSrcModule } from "../harness/loadSrcModule.ts";
import { installMemoryLocalStorage } from "../harness/fakeGlobals.ts";

interface SelectedProviderModule {
  withoutSecrets(variables: Record<string, string>): Record<string, string>;
  persistSelectedProvider(
    storageKey: string,
    selected: { provider: string; variables: Record<string, string> }
  ): void;
}

installMemoryLocalStorage();
const store = globalThis.localStorage!;

const { withoutSecrets, persistSelectedProvider } =
  await loadSrcModule<SelectedProviderModule>(
    "lib/storage/selected-provider.ts"
  );

beforeEach(() => store.clear());

test("secret-named variables are dropped and everything else survives", () => {
  assert.deepEqual(
    withoutSecrets({
      api_key: "sk-live",
      model: "gpt-4o-mini",
      region: "eastus",
      auth_token: "tok",
      project_id: "p",
    }),
    { model: "gpt-4o-mini", region: "eastus", project_id: "p" }
  );
});

test("what is written holds neither the name nor the value of a secret", () => {
  persistSelectedProvider("curl_selected_ai_provider", {
    provider: "openai",
    variables: { api_key: "sk-live-value", model: "gpt-4o-mini" },
  });

  const written = store.getItem("curl_selected_ai_provider") ?? "";
  assert.doesNotMatch(written, /sk-live-value/);
  assert.doesNotMatch(written, /api_key/);
  assert.match(written, /gpt-4o-mini/);
  assert.equal(JSON.parse(written).provider, "openai");
});

test("a provider with no variables at all still round-trips", () => {
  persistSelectedProvider("curl_selected_stt_provider", {
    provider: "gemini-stt",
    variables: {},
  });
  assert.deepEqual(
    JSON.parse(store.getItem("curl_selected_stt_provider") ?? "{}"),
    { provider: "gemini-stt", variables: {} }
  );
});

test("an empty provider id is not persisted", () => {
  // The context runs this effect on mount, before anything is selected.
  persistSelectedProvider("curl_selected_ai_provider", {
    provider: "",
    variables: {},
  });
  assert.equal(store.getItem("curl_selected_ai_provider"), null);
});
