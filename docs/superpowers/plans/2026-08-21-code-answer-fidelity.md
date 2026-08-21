# Code Answer Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Omni usable for code-shaped questions end to end — a capture the model can actually read, a system prompt that does not cap code at 2-4 sentences, and code blocks in the HUD that cannot be misread as containing line breaks they do not have.

**Architecture:** Three independent defect chains, each fixed at its own layer and gated by the test surface that already exists. TASK-4 (prompt) changes two constant files plus one threaded parameter through the single `buildEnhancedSystemPrompt` call site, gated by new `node --test` unit tests in `evals/unit/`. TASK-2 (capture) removes a broken one-time-defaults migration so the working region-capture path becomes the persisted default, adds a global shortcut that reaches region capture without settings, and adds a one-time notice on the full-screen path. TASK-3 (rendering) is a CSS change to two rules plus one new `dev-harness/probe.mjs` assertion. No new npm or cargo dependency is added, and no new Tauri command is introduced.

**Tech Stack:** React 19 + TypeScript (strict) + Vite + Tailwind v4, Tauri v2 (Rust), Streamdown 1.6.10 for markdown, Node's built-in test runner (`node --test`) for unit tests, Playwright's WebKit driven as a raw library for the HUD probe.

**Spec:** `backlog/tasks/task-2 - Region-capture-not-whole-screen-by-default.md`, `backlog/tasks/task-3 - Code-blocks-wrap-indistinguishably-from-real-newlines-at-600px.md`, `backlog/tasks/task-4 - No-coding-mode-and-the-short-response-setting-caps-code-answers-at-2-4-sentences.md`

## Global Constraints

- **Branch off `main`.** The working tree is currently on `feat/system-audio-process-tap` with two unpushed commits (`5194dad`, `123905b`) that are unrelated to this work. Start with `git -C /Users/tessaro/omni fetch origin && git -C /Users/tessaro/omni switch -c fix/code-answer-fidelity origin/main`.
- **Node ≥ 22.18** (`package.json` `engines.node`). The `evals/**/*.test.ts` files are TypeScript executed directly by `node --test`; Node 20 fails to load them.
- **No new dependencies.** Not npm, not cargo. `npm audit --audit-level=high` is a gating CI job.
- **TypeScript strict.** Root `tsconfig.json` sets `strict: true` and `noEmit: true`. `evals/tsconfig.json` is separately strict with `NodeNext` resolution.
- **There is no test runner for `src/`.** No vitest, no jest, no `playwright.config.*`, no `test` script. Every new automated test in this plan goes into either `evals/unit/*.test.ts` (run by `node --test`) or `dev-harness/probe.mjs` (the HUD probe). Do not add a test framework.
- **The HUD is 600px wide**, from `src-tauri/tauri.conf.json:17-18` (`"width": 600, "height": 54`). `dev-harness/probe.mjs:19-20` mirrors those as `HUD_WIDTH`/`HUD_RESTING_HEIGHT`.
- **New DOM elements get a `data-slot` attribute**, not a class selector, so the probe can target them (`dev-harness/README.md`, "Adding a check").
- **Probe detail strings carry the measured numbers even on a pass** (`dev-harness/README.md`): the numbers are what make a later regression obvious.
- **`npm run hud:probe` can fail 2 layout assertions on the first run after a fresh `vite` start**, then pass 23/23 on every subsequent run. Cold-start timing, not a regression. Re-run before believing a failure.
- **Use absolute paths in shell commands and never prefix with `cd`** — the working directory persists between calls and has broken a `tsc -p` invocation before.
- **`dev-harness/tauri-mock.js` must mirror the real command shape** whenever a Tauri command's signature or return changes, or CI can pass on a bug that fails in the app.
- **CI gates a PR with:** `npx tsc --noEmit`, `npm run eval:typecheck`, `npm run check:commands`, `npm run eval:test`, `npm run eval:dry-run`, `npm run build` (job `check-frontend`); `npm run hud:probe` against a live `npm run dev` (job `check-hud`, macOS); `cargo check` + `cargo test` (job `check-rust`, macOS); `cargo clippy --all-targets -- -D warnings` (job `rust-lint`); `npm audit --audit-level=high` (job `audit`).

## Stated assumption, because the spec cannot be met literally

TASK-4 acceptance criterion #2 reads "Response-length caps do not apply to answers containing code." Nothing can know whether an answer contains code before the answer exists — the length instruction is appended to the system prompt on the way out, and the only prompt-side lever is text (there is no `max_tokens` wired to response length anywhere; the only two token caps in the repo are hardcoded literals in the `claude` and `groq` curl templates, `src/config/ai-providers.constants.ts:25,88`).

This plan therefore satisfies the criterion in two layers, and Task 1 plus Task 2 together are what "AC #2 is met" means here:

1. **Unconditional (Task 1).** Every response-length instruction is amended to bind prose only, and to say explicitly that code blocks are emitted in full regardless of the limit. This covers every path with zero plumbing, including the three call sites that never see a slash command (`useSystemAudio.ts`, `Generate.tsx`, the chat page).
2. **Explicit intent (Task 2).** When the turn is known to be code-shaped — a `/code`, `/refactor`, `/commit`, or `/regex` slash command, or the built-in Code profile from Task 3 being the active system prompt — the length instruction is not appended at all.

An inferred heuristic over the raw `userMessage` was deliberately not used. `/fix` and `/explain` and `/summarize` are prose commands whose expanded text mentions neither code nor prose distinctly, and a false positive silently removes a setting the user chose.

## File Structure

**TASK-4, prompt layer**

- `src/lib/response-settings.constants.ts` — modify. `RESPONSE_LENGTHS[].prompt` for all three options gains the prose-only carve-out (Task 1).
- `src/config/constants.ts` — modify. Add `CODING_SYSTEM_PROMPT` next to `DEFAULT_SYSTEM_PROMPT`, and add two `STORAGE_KEYS` entries used by Tasks 3 and 6 (Task 3, Task 6).
- `src/lib/functions/ai-response.function.ts` — modify. `buildEnhancedSystemPrompt` gains a third parameter; `fetchAIResponse`'s params gain `codeIntent`; the single call site threads it (Task 2).
- `evals/harness/runTask.ts` — modify. `FetchAIResponseParams` (line 29) is a hand-maintained mirror of `fetchAIResponse`'s params; it must gain the same optional field or `npm run eval:typecheck` fails (Task 2).
- `src/hooks/useCompletion.ts` — modify. The slash-command block sets a local `codeIntent` and passes it to both branches (Task 2).
- `src/lib/system-prompts.constants.ts` — **create.** Holds `BUILTIN_SYSTEM_PROMPTS`, the shipped Code profile as a `SystemPrompt`-shaped record with a negative id. One responsibility: the built-in profile data (Task 3).
- `src/hooks/useSystemPrompts.ts` — modify. Merge built-ins into the listed prompts, and refuse edit/delete on a negative id (Task 3).
- `evals/unit/response-length.test.ts` — **create.** Asserts the carve-out text and the codeIntent bypass on real assembled request bodies (Tasks 1, 2, 3).

**TASK-2, capture layer**

- `src/contexts/app.context.tsx` — modify. Flip the `useState` default to the region-capture path, delete `applyOneTimeScreenshotDefaults` and its call, and register the new region shortcut callback (Tasks 4, 5).
- `src/config/shortcuts.ts` — modify. Add a `screenshot-region` shortcut definition (Task 5).
- `src-tauri/src/shortcuts.rs` — modify. Add the dispatch arm and the emit for the new action (Task 5).
- `src/hooks/useGlobalShortcuts.ts` — modify. Listen for the new event and expose a registration function (Task 5).
- `src/pages/app/components/completion/Input.tsx` — modify. Render the one-time full-screen notice (Task 6).
- `evals/tasks/vision.tasks.ts` — modify. Add the region-capture counterpart task (Task 7).
- `evals/README.md` — modify. The "Baseline" and "Grading philosophy" sections still claim vision tasks are unautomated and skipped, which is stale (Task 7).

**TASK-3, rendering layer**

- `src/tailwind.css` — modify, lines 208-214 only (Task 8).
- `dev-harness/probe.mjs` — modify. One new assertion, taking the count from 23 to 24 (Task 8).

---

### Task 1: Response-length instructions bind prose, not code

**Files:**
- Modify: `src/lib/response-settings.constants.ts:15-39`
- Create: `evals/unit/response-length.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `RESPONSE_LENGTHS` entries whose `prompt` strings all contain the literal substring `never shorten, truncate, elide, or summarise code`. Task 2's test reuses `evals/unit/response-length.test.ts`'s `sendAndCaptureBody` helper, exported from that file as `export const sendAndCaptureBody`.

- [ ] **Step 1: Write the failing test**

Create `evals/unit/response-length.test.ts`. The scaffold is lifted from `evals/unit/image-grounding.test.ts` (same harness, same provider fixture, same capture pattern) with `responseLength` made a parameter instead of pinned to `"auto"`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test /Users/tessaro/omni/evals/unit/response-length.test.ts`

Expected: FAIL. The first test fails on the `"short"` option with `the "short" prompt must exempt code from its length limit`, and the third fails the same way. The second test passes already.

- [ ] **Step 3: Amend the three prompt strings**

In `src/lib/response-settings.constants.ts`, replace the `prompt` value of each of the three entries. The carve-out sentence is identical in all three on purpose — it is asserted as a literal.

`short` (currently line 22):

```ts
    prompt:
      "IMPORTANT: You must keep your prose extremely brief and concise. Limit your prose to 2-4 sentences maximum. Provide only the most essential information. Do not include explanations, examples, or additional context unless explicitly requested. Get straight to the point. These limits govern prose only: never shorten, truncate, elide, or summarise code. Emit every line of every code block in full, even when that runs far longer than the prose limit. This is a strict requirement.",
```

`medium` (currently line 30):

```ts
    prompt:
      "IMPORTANT: Provide responses with moderate length - not too brief, not too lengthy. Keep your prose to 1-2 paragraphs (approximately 4-8 sentences). Include key explanations and relevant details, but avoid being overly verbose or adding unnecessary elaboration. Stay focused and well-organized. These limits govern prose only: never shorten, truncate, elide, or summarise code. Emit every line of every code block in full, even when that runs far longer than the prose limit. This is a strict requirement.",
```

`auto` (currently line 37):

```ts
    prompt:
      "IMPORTANT: Carefully assess the complexity and scope of the question, then adjust your response length accordingly. For simple questions, be brief (2-4 sentences). For moderate questions, provide balanced detail (1-2 paragraphs). For complex questions, give comprehensive answers with appropriate depth. Always match the prose length to what the question actually requires - no more, no less. These limits govern prose only: never shorten, truncate, elide, or summarise code. Emit every line of every code block in full, even when that runs far longer than the prose limit.",
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test /Users/tessaro/omni/evals/unit/response-length.test.ts`

Expected: PASS, 3/3.

- [ ] **Step 5: Wire the new file into the suite and confirm the gates**

`npm run eval:test` already globs `evals/unit/*.test.ts` (`package.json:18`), so no script change is needed. Confirm:

Run: `npm run eval:test`
Expected: PASS, including the three new tests and the five pre-existing unit files.

Run: `npm run eval:typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git -C /Users/tessaro/omni add src/lib/response-settings.constants.ts evals/unit/response-length.test.ts
git -C /Users/tessaro/omni commit -m "fix(prompt): response-length limits bind prose, not code"
```

---

### Task 2: An explicit code turn drops the length instruction entirely

**Files:**
- Modify: `src/lib/functions/ai-response.function.ts:42-45` (signature), `:60-64` (the length push), `:77-88` (params type), `:105-108` (the call site)
- Modify: `evals/harness/runTask.ts:29` (`FetchAIResponseParams`)
- Modify: `src/hooks/useCompletion.ts:259-283` (slash-command block), `:395-415` (both `fetchAIResponse`/`runAgentLoopAsText` branches)
- Modify: `evals/unit/response-length.test.ts` (add two tests)

**Interfaces:**
- Consumes: `sendAndCaptureBody(responseLength, extra)` from Task 1's `evals/unit/response-length.test.ts`.
- Produces: `fetchAIResponse` accepts an optional `codeIntent?: boolean` in its params object; when `true`, no `RESPONSE_LENGTHS` prompt is appended. `buildEnhancedSystemPrompt(baseSystemPrompt?: string, hasImages?: boolean, codeIntent?: boolean)`. Task 3 sets `codeIntent` from the active profile.

- [ ] **Step 1: Write the failing tests**

Append to `evals/unit/response-length.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test /Users/tessaro/omni/evals/unit/response-length.test.ts`

Expected: FAIL on both new tests. `codeIntent` is not a known property, so TypeScript-via-node either errors on the excess property or the value is ignored and `2-4 sentences` is still in the body.

- [ ] **Step 3: Thread the parameter through `ai-response.function.ts`**

Change the signature (currently lines 42-45):

```ts
function buildEnhancedSystemPrompt(
  baseSystemPrompt?: string,
  hasImages = false,
  codeIntent = false
): string {
```

Wrap the length lookup (currently lines 60-64) so it is skipped on a code turn. Replace:

```ts
  const lengthOption = RESPONSE_LENGTHS.find(
    (l) => l.id === responseSettings.responseLength
  );
  if (lengthOption?.prompt?.trim()) {
    prompts.push(lengthOption.prompt);
  }
```

with:

```ts
  // A length setting is a preference about prose. On a turn the user explicitly
  // marked as code — a /code, /refactor, /commit or /regex command, or the Code
  // profile being active — appending any sentence cap is a request to truncate a
  // diff, so the option is skipped rather than softened.
  if (!codeIntent) {
    const lengthOption = RESPONSE_LENGTHS.find(
      (l) => l.id === responseSettings.responseLength
    );
    if (lengthOption?.prompt?.trim()) {
      prompts.push(lengthOption.prompt);
    }
  }
```

Add the field to the params type (currently lines 77-88), after `imagesBase64`:

```ts
  imagesBase64?: string[];
  codeIntent?: boolean;
  signal?: AbortSignal;
```

Add it to the destructure (currently lines 90-98):

```ts
      imagesBase64 = [],
      codeIntent = false,
      signal,
```

Pass it at the single call site (currently lines 105-108):

```ts
    const enhancedSystemPrompt = buildEnhancedSystemPrompt(
      systemPrompt,
      imagesBase64.length > 0,
      codeIntent
    );
```

- [ ] **Step 4: Mirror the field in the eval harness type**

`evals/harness/runTask.ts:29` declares `FetchAIResponseParams` by hand. Add the same optional field there, or `npm run eval:typecheck` fails on the new tests:

```ts
  imagesBase64?: string[];
  codeIntent?: boolean;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test /Users/tessaro/omni/evals/unit/response-length.test.ts`
Expected: PASS, 5/5.

Run: `npm run eval:typecheck`
Expected: PASS.

- [ ] **Step 6: Set `codeIntent` from the slash commands**

In `src/hooks/useCompletion.ts`, in the block that currently starts at line 259 with `const useTools = matches("/solve");`, add a sibling declaration immediately after it:

```ts
      // These four rewrite the turn into a request for code. /fix, /explain,
      // /summarize and /translate are prose commands and are deliberately absent.
      const codeIntent =
        matches("/code") ||
        matches("/refactor") ||
        matches("/commit") ||
        matches("/regex");
```

Then pass it in both branches of the call at lines 395-415, so the field appears twice — once on the `runAgentLoopAsText` argument object and once on the `fetchAIResponse` one:

```ts
      const responseStream = useTools
        ? runAgentLoopAsText({
            fetchAIResponse,
            provider,
            selectedProvider: selectedAIProvider,
            systemPrompt: systemPrompt || undefined,
            history: messageHistory,
            userMessage,
            imagesBase64,
            codeIntent,
            signal,
            toolNames: Object.keys(TOOLS),
          })
        : fetchAIResponse({
            provider: provider,
            selectedProvider: selectedAIProvider,
            systemPrompt: systemPrompt || undefined,
            history: messageHistory,
            userMessage,
            imagesBase64,
            codeIntent,
            signal,
          });
```

`runAgentLoopAsText` forwards its params into `fetchAIResponse` (`src/lib/agent/loop.ts:129-131` is where it rebuilds the object per iteration). Read that call and add `codeIntent` to the forwarded object there too, and to the loop's own params type, so the tool path is not silently exempt.

- [ ] **Step 7: Verify the frontend typechecks and builds**

Run: `npx tsc --noEmit -p /Users/tessaro/omni/tsconfig.json`
Expected: PASS, no errors.

Run: `npm run eval:test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git -C /Users/tessaro/omni add src/lib/functions/ai-response.function.ts src/lib/agent/loop.ts src/hooks/useCompletion.ts evals/harness/runTask.ts evals/unit/response-length.test.ts
git -C /Users/tessaro/omni commit -m "feat(prompt): a code slash command drops the prose length cap"
```

---

### Task 3: A built-in Code profile, selectable where profiles already live

**Files:**
- Create: `src/lib/system-prompts.constants.ts`
- Modify: `src/config/constants.ts:32-34` (add `CODING_SYSTEM_PROMPT`)
- Modify: `src/hooks/useSystemPrompts.ts` (merge built-ins; guard edit/delete)
- Modify: `src/pages/system-prompts/index.tsx` (hide destructive actions on a built-in)
- Modify: `evals/unit/response-length.test.ts` (add one test)

**Interfaces:**
- Consumes: `codeIntent` from Task 2.
- Produces: `CODING_SYSTEM_PROMPT: string` exported from `src/config/constants.ts`; `BUILTIN_SYSTEM_PROMPTS: SystemPrompt[]` and `isBuiltinSystemPrompt(id: number): boolean` exported from `src/lib/system-prompts.constants.ts`. Built-in ids are negative; `CODE_PROFILE_ID = -1`.

This satisfies TASK-4 acceptance criterion #1. It reuses the shipped profile mechanism rather than adding a second one: `SystemPrompt` records already have SQLite CRUD (`src/lib/database/system-prompt.action.ts`), a hook that mirrors selection into `STORAGE_KEYS.SYSTEM_PROMPT` and `STORAGE_KEYS.SELECTED_SYSTEM_PROMPT_ID` (`src/hooks/useSystemPrompts.ts`), and a card-grid UI at `/system-prompts` already labelled "AI behavior profiles". What is missing is that `getAllSystemPrompts()` only ever returns rows the user typed, so the app ships with an empty gallery.

- [ ] **Step 1: Write the failing test**

Append to `evals/unit/response-length.test.ts`:

```ts
interface ConstantsModule {
  CODING_SYSTEM_PROMPT: string;
  DEFAULT_SYSTEM_PROMPT: string;
}

const { CODING_SYSTEM_PROMPT, DEFAULT_SYSTEM_PROMPT } =
  await loadSrcModule<ConstantsModule>("config/constants.ts");

test("the Code profile is a real coding prompt, not the default one", () => {
  assert.notEqual(
    CODING_SYSTEM_PROMPT,
    DEFAULT_SYSTEM_PROMPT,
    "the Code profile must not just repeat the generic assistant prompt"
  );
  // The generic prompt's own instruction to be concise is the thing that made a
  // multi-file diff come back as a summary. A coding profile must not inherit it.
  assert.ok(
    !/\bconcise\b/i.test(CODING_SYSTEM_PROMPT),
    "a coding prompt must not ask for concision"
  );
  assert.match(CODING_SYSTEM_PROMPT, /complete|runnable|full/i);
});

test("the Code profile is shipped as a selectable built-in", async () => {
  interface BuiltinsModule {
    BUILTIN_SYSTEM_PROMPTS: Array<{ id: number; name: string; prompt: string }>;
    isBuiltinSystemPrompt(id: number): boolean;
  }
  const { BUILTIN_SYSTEM_PROMPTS, isBuiltinSystemPrompt } =
    await loadSrcModule<BuiltinsModule>("lib/system-prompts.constants.ts");

  const code = BUILTIN_SYSTEM_PROMPTS.find((p) => p.name === "Code");
  assert.ok(code, "a built-in profile named Code must ship");
  assert.equal(code.prompt, CODING_SYSTEM_PROMPT);
  // Negative so it can never collide with a SQLite autoincrement rowid.
  assert.ok(code.id < 0, "built-in ids must be negative");
  assert.ok(isBuiltinSystemPrompt(code.id));
  assert.ok(!isBuiltinSystemPrompt(1));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test /Users/tessaro/omni/evals/unit/response-length.test.ts`

Expected: FAIL. `CODING_SYSTEM_PROMPT` is not exported from `config/constants.ts`, and `lib/system-prompts.constants.ts` does not exist, so `loadSrcModule` throws.

- [ ] **Step 3: Add the prompt constant**

In `src/config/constants.ts`, immediately after `DEFAULT_SYSTEM_PROMPT` (currently lines 32-34):

```ts
// The generic prompt above asks for concision, which is correct for a HUD answer
// and wrong for a diff: with the short response length also on, a request for a
// multi-file change came back as a description of the change. This profile is the
// selectable opposite — it never trades completeness of code for brevity.
export const CODING_SYSTEM_PROMPT =
  "You are a senior software engineer pair-programming through a small always-on " +
  "overlay. Answer with code first and prose second. Emit complete, runnable code: " +
  "never abbreviate a body to a comment, never write an ellipsis in place of lines, " +
  "and never describe a change you could show. Always fence code in triple backticks " +
  "with the language tag. When you change existing code, show the full changed " +
  "function or block rather than a fragment the reader has to splice. State the file " +
  "path above each block when more than one file is involved. If the request is " +
  "ambiguous, make the smallest reasonable assumption, say what you assumed in one " +
  "line, and write the code anyway.";
```

- [ ] **Step 4: Create the built-in profile module**

Create `src/lib/system-prompts.constants.ts`:

```ts
import { CODING_SYSTEM_PROMPT } from "@/config/constants";
import { SystemPrompt } from "@/types";

// Built-ins carry negative ids so they can never collide with a SQLite
// autoincrement rowid, which is what lets them sit in the same list, behind the
// same selection handler, as a profile the user typed.
export const CODE_PROFILE_ID = -1;

const BUILTIN_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export const BUILTIN_SYSTEM_PROMPTS: SystemPrompt[] = [
  {
    id: CODE_PROFILE_ID,
    name: "Code",
    prompt: CODING_SYSTEM_PROMPT,
    created_at: BUILTIN_TIMESTAMP,
    updated_at: BUILTIN_TIMESTAMP,
  },
];

export const isBuiltinSystemPrompt = (id: number): boolean => id < 0;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test /Users/tessaro/omni/evals/unit/response-length.test.ts`
Expected: PASS, 7/7.

- [ ] **Step 6: Merge built-ins into the profile list and guard mutation**

Read `src/hooks/useSystemPrompts.ts` in full first — it owns `prompts`, `selectedPromptId`, and the localStorage mirroring, and the exact line numbers shift as you edit.

Three changes:

1. Where `prompts` is populated from `getAllSystemPrompts()`, prepend the built-ins so they appear first in the gallery:

```ts
import {
  BUILTIN_SYSTEM_PROMPTS,
  isBuiltinSystemPrompt,
} from "@/lib/system-prompts.constants";

// ... at the point where the DB rows land in state:
setPrompts([...BUILTIN_SYSTEM_PROMPTS, ...rows]);
```

2. In the delete handler, refuse a built-in rather than issuing a `DELETE` that matches no row and silently succeeds:

```ts
    if (isBuiltinSystemPrompt(promptId)) {
      throw new Error("Built-in profiles cannot be deleted");
    }
```

3. In the update/edit handler, the same guard with `"Built-in profiles cannot be edited"`.

`handleSelectPrompt` (currently lines 163-183) needs no change: it looks the prompt up in `prompts` by id and writes `selectedPrompt.prompt` into `STORAGE_KEYS.SYSTEM_PROMPT`, which works identically for a built-in now that it is in the array.

- [ ] **Step 7: Hide the destructive actions on a built-in card**

In `src/pages/system-prompts/index.tsx`, find the per-card action buttons (the Edit and Delete controls rendered inside the mapped card). Wrap them so they do not render for a built-in, and give the card a `data-slot` so the change is assertable:

```tsx
{!isBuiltinSystemPrompt(prompt.id) && (
  <>
    {/* the existing Edit and Delete buttons, unchanged */}
  </>
)}
```

Add `data-slot="system-prompt-card"` and `data-builtin={isBuiltinSystemPrompt(prompt.id) ? "true" : "false"}` to the card element itself. The empty state at lines 193-199 ("No prompts found") is now unreachable with built-ins shipped; leave it, since a future build could ship none.

- [ ] **Step 8: Set `codeIntent` when the Code profile is active**

In `src/hooks/useCompletion.ts`, extend the `codeIntent` declaration added in Task 2 so the profile also counts:

```ts
      const codeProfileActive =
        safeLocalStorage.getItem(STORAGE_KEYS.SELECTED_SYSTEM_PROMPT_ID) ===
        String(CODE_PROFILE_ID);
      const codeIntent =
        codeProfileActive ||
        matches("/code") ||
        matches("/refactor") ||
        matches("/commit") ||
        matches("/regex");
```

Import `CODE_PROFILE_ID` from `@/lib/system-prompts.constants` and `STORAGE_KEYS` from `@/config/constants` if not already imported in that file.

- [ ] **Step 9: Verify**

Run: `npx tsc --noEmit -p /Users/tessaro/omni/tsconfig.json`
Expected: PASS.

Run: `npm run eval:test`
Expected: PASS.

Run: `npm run build`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git -C /Users/tessaro/omni add src/config/constants.ts src/lib/system-prompts.constants.ts src/hooks/useSystemPrompts.ts src/hooks/useCompletion.ts src/pages/system-prompts/index.tsx evals/unit/response-length.test.ts
git -C /Users/tessaro/omni commit -m "feat(prompt): ship a selectable Code profile"
```

---

### Task 4: Region capture is the default, and the default survives a relaunch

**Files:**
- Modify: `src/contexts/app.context.tsx:123-128` (the `useState` default), `:145-156` (delete `applyOneTimeScreenshotDefaults`), `:303-307` (delete its call)

**Interfaces:**
- Consumes: nothing.
- Produces: a fresh install resolves to `screenshotConfiguration.enabled === false`, which is the branch that reaches `capture_selected_area`. `applyOneTimeScreenshotDefaults` and the raw `"auto-configs-enabled"` localStorage key no longer exist.

The ticket says the default is `{ enabled: true, mode: "manual" }`. It is worse than that: `applyOneTimeScreenshotDefaults` already tries to move new users onto region capture, and cannot. It calls `setScreenshotConfiguration` (React state) without ever writing `STORAGE_KEYS.SCREENSHOT_CONFIG`, but it does persist its own `"auto-configs-enabled"` sentinel. So the override survives exactly one session, the sentinel survives forever, and on the second launch the `useState` default is what the user gets — permanently, unless they open Settings and touch the Capture Method dropdown, which is the only code path that writes the key (`src/hooks/useSettings.ts:51-58`). Flipping the `useState` default without deleting this function would leave a migration that fires once, writes nothing, and then blocks itself.

- [ ] **Step 1: Write the failing test**

There is no test runner for `src/`, and this is context state, not a pure function. The honest gate is the HUD probe, which boots the real React tree against `dev-harness/tauri-mock.js` and can read what the app asked for. Append to `dev-harness/probe.mjs`, in the numbered-section style the file uses, after the resting-geometry assertions:

```js
  // 1c. a fresh profile defaults to region capture, not the whole screen.
  //
  // A full-screen capture at 2560x1600 is transcribed to about 60% and then
  // stops, silently. Region capture is measured at 0-1.7% character error. The
  // default that decides which one a new user gets used to be set by a one-time
  // migration that never persisted, so the whole-screen path won on relaunch.
  const captureDefault = await page.evaluate(() => {
    const raw = localStorage.getItem("screenshot_config");
    const button = document.querySelector('[data-slot="hud-screenshot"]');
    return {
      raw,
      legacySentinel: localStorage.getItem("auto-configs-enabled"),
      title: button?.getAttribute("title") ?? null,
    };
  });
  record(
    "a fresh profile defaults to region capture",
    captureDefault.title !== null &&
      captureDefault.title.startsWith("Selection mode") &&
      captureDefault.legacySentinel === null,
    `title=${JSON.stringify(captureDefault.title)} ` +
      `screenshot_config=${captureDefault.raw ?? "(unset)"} ` +
      `auto-configs-enabled=${captureDefault.legacySentinel ?? "(absent)"}`
  );
```

This needs two things the app does not yet expose: a `data-slot` on the HUD screenshot button, and a title that starts with the mode name. Both are in Step 3.

- [ ] **Step 2: Run the probe to verify it fails**

Two shells. Shell 1: `npm run dev`. Shell 2 once vite is serving:

Run: `npm run hud:probe`
Expected: FAIL on `a fresh profile defaults to region capture`, with detail showing `title=null` (no `data-slot` yet). Total 24 assertions, 1 failing. If two *other* layout assertions also fail, that is the documented cold-start flake — re-run before believing them.

- [ ] **Step 3: Flip the default and delete the broken migration**

In `src/contexts/app.context.tsx`, change the `useState` initialiser (currently lines 123-128) to:

```ts
  const [screenshotConfiguration, setScreenshotConfiguration] =
    useState<ScreenshotConfig>({
      // Region capture, not the whole screen. A full-screen grab at native
      // resolution is transcribed to roughly 60% and then stops with no error;
      // a dragged region measures 0-1.7% character error. `mode` is only read on
      // the `enabled: true` branch, so it is inert here.
      mode: "manual",
      autoPrompt: "Analyze this screenshot and provide insights",
      enabled: false,
    });
```

Delete `applyOneTimeScreenshotDefaults` entirely (currently lines 145-156) and its call in the mount effect (currently lines 303-307), leaving:

```ts
  useEffect(() => {
    loadData();
  }, []);
```

Anyone who already chose Screenshot Mode has `screenshot_config` persisted, and `loadData()` (lines 181-200) still restores it, so this changes the default only — it does not override an existing choice.

In `src/pages/app/components/completion/Screenshot.tsx`, add the probe hook and make the title lead with the mode. Replace the `captureMode` line and the `title` prop:

```tsx
  const captureMode = screenshotConfiguration.enabled
    ? "Screenshot mode (whole screen)"
    : "Selection mode (drag a region)";
```

```tsx
      data-slot="hud-screenshot"
      title={
        !supportsImages
          ? "Screenshot not supported by current AI provider"
          : `${captureMode} - ${attachedFiles.length}/${MAX_FILES} files`
      }
```

The `processingMode` variable becomes unused once it is out of the title; delete its declaration so `tsc` stays clean.

- [ ] **Step 4: Run the probe to verify it passes**

Run: `npm run hud:probe`
Expected: PASS 24/24. Re-run once if a cold-start layout assertion fails.

- [ ] **Step 5: Verify nothing else moved**

Run: `npx tsc --noEmit -p /Users/tessaro/omni/tsconfig.json`
Expected: PASS.

Run: `npm run check:commands`
Expected: PASS — the invoke/command parity is unchanged, both capture commands were already registered.

- [ ] **Step 6: Commit**

```bash
git -C /Users/tessaro/omni add src/contexts/app.context.tsx src/pages/app/components/completion/Screenshot.tsx dev-harness/probe.mjs
git -C /Users/tessaro/omni commit -m "fix(capture): default to region capture and persist it"
```

---

### Task 5: Region capture without opening Settings

**Files:**
- Modify: `src/config/shortcuts.ts:64-73` (add a definition after the existing `screenshot` entry)
- Modify: `src-tauri/src/shortcuts.rs:89` (dispatch arm), `:270-277` (a sibling emit function)
- Modify: `src/hooks/useGlobalShortcuts.ts:181-213` (event listener + registration)
- Modify: `src/hooks/useCompletion.ts:1291-1302` (register the callback), `:1145-1214` (`captureScreenshot` gains a forced-region variant)

**Interfaces:**
- Consumes: nothing from Tasks 1-4 beyond the flipped default.
- Produces: a `screenshot-region` shortcut id, a `trigger-screenshot-region` Tauri event, and `globalShortcuts.registerScreenshotRegionCallback(fn)`. `captureScreenshot` gains an optional `forceRegion?: boolean` argument that bypasses the config branch and always invokes `start_screen_capture`.

This is TASK-2 acceptance criterion #1. No new Tauri command is needed — `start_screen_capture` is already registered (`src-tauri/src/lib.rs:63`), so `npm run check:commands` stays green.

- [ ] **Step 1: Write the failing test**

The dispatch table is Rust and already has unit tests. Append to the existing `#[cfg(test)] mod tests` in `src-tauri/src/shortcuts.rs` (currently ending at line 685):

```rust
    #[test]
    fn region_capture_has_its_own_shipped_binding() {
        // Region capture reads at 0-1.7% character error where a full-screen grab
        // reads about 60% of the same code and stops. It must be reachable from the
        // keyboard without opening Settings, whatever the saved capture mode is.
        let defaults = default_shortcuts();
        let region = defaults
            .iter()
            .find(|s| s.id == "screenshot-region")
            .expect("screenshot-region must ship a default binding");
        let screenshot = defaults
            .iter()
            .find(|s| s.id == "screenshot")
            .expect("screenshot must ship a default binding");
        assert_ne!(
            region.default_key, screenshot.default_key,
            "the two capture shortcuts must not collide"
        );
    }
```

If `default_shortcuts()` is not the accessor name used by the three existing tests in that module (`shipped_default_shortcuts_all_parse` is the one to read), use whatever those tests use — they already reach the shipped list.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path /Users/tessaro/omni/src-tauri/Cargo.toml region_capture_has_its_own_shipped_binding`

Expected: FAIL with `screenshot-region must ship a default binding`.

- [ ] **Step 3: Add the shortcut definition**

In `src/config/shortcuts.ts`, after the existing `screenshot` entry (lines 64-73):

```ts
  {
    id: "screenshot-region",
    name: "Capture region",
    description: "Drag to capture part of the screen, whatever the saved mode is",
    defaultKey: {
      macos: "cmd+shift+d",
      windows: "ctrl+shift+d",
      linux: "ctrl+shift+d",
    },
  },
```

The Rust side reads the shipped list, so this is what the new test asserts against. If the Rust default list is a separate literal rather than generated from this file, add the matching entry there too — `shipped_default_shortcuts_all_parse` will tell you which by failing to parse.

- [ ] **Step 4: Emit the event from Rust**

In `src-tauri/src/shortcuts.rs`, add a dispatch arm next to the existing one at line 89:

```rust
        "screenshot-region" => handle_screenshot_region_shortcut(app),
```

and a sibling emitter next to `handle_screenshot_shortcut` (lines 270-277):

```rust
fn handle_screenshot_region_shortcut<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(e) = window.emit("trigger-screenshot-region", json!({})) {
            eprintln!("Failed to emit region screenshot event: {}", e);
        }
    }
}
```

- [ ] **Step 5: Run the Rust gates to verify they pass**

Run: `cargo test --manifest-path /Users/tessaro/omni/src-tauri/Cargo.toml`
Expected: PASS, including the new test.

Run: `cargo clippy --manifest-path /Users/tessaro/omni/src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: PASS, no warnings.

- [ ] **Step 6: Listen for it on the frontend**

In `src/hooks/useGlobalShortcuts.ts`, mirror the `trigger-screenshot` listener at lines 181-213 for `trigger-screenshot-region`, with its own callback ref and its own 300ms debounce, and export `registerScreenshotRegionCallback` alongside `registerScreenshotCallback`.

In `src/hooks/useCompletion.ts`, give `captureScreenshot` (line 1145) an optional argument and bypass the branch when it is set:

```ts
  const captureScreenshot = async (forceRegion = false) => {
```

and change the branch at lines 1186-1201 so a forced region skips the full-screen path:

```ts
      if (config.enabled && !forceRegion) {
        const base64 = await invoke("capture_to_base64");
        // ... unchanged
      } else {
        // Selection Mode: Open overlay to select an area
        isProcessingScreenshotRef.current = false;
        await invoke("start_screen_capture");
      }
```

Register it next to the existing callbacks at lines 1291-1302:

```ts
    globalShortcuts.registerScreenshotRegionCallback(() =>
      captureScreenshot(true)
    );
```

`captureScreenshot` is also passed straight to `onClick` in `Screenshot.tsx` and `ChatScreenshot.tsx`. React passes the click event as the first argument, which would arrive as a truthy `forceRegion`. Change those call sites to `onClick={() => captureScreenshot()}` so a click keeps honouring the saved mode.

Apply the same `forceRegion` change to `useChatCompletion.ts`'s duplicate of the branch (lines 600-616) so the chat page does not diverge.

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit -p /Users/tessaro/omni/tsconfig.json`
Expected: PASS.

Run: `npm run check:commands`
Expected: PASS — `start_screen_capture` was already registered, so parity is unchanged.

Two shells (`npm run dev`, then):
Run: `npm run hud:probe`
Expected: PASS 24/24.

- [ ] **Step 8: Commit**

```bash
git -C /Users/tessaro/omni add src/config/shortcuts.ts src-tauri/src/shortcuts.rs src/hooks/useGlobalShortcuts.ts src/hooks/useCompletion.ts src/hooks/useChatCompletion.ts src/pages/app/components/completion/Screenshot.tsx src/pages/chats/components/ChatScreenshot.tsx
git -C /Users/tessaro/omni commit -m "feat(capture): a dedicated region-capture shortcut"
```

---

### Task 6: A full-screen capture says once that a region reads better

**Files:**
- Modify: `src/config/constants.ts` (one `STORAGE_KEYS` entry)
- Modify: `src/hooks/useCompletion.ts` (set the flag on the full-screen branch)
- Modify: `src/pages/app/components/completion/Input.tsx` (render the notice)
- Modify: `dev-harness/probe.mjs` (one assertion)

**Interfaces:**
- Consumes: `captureScreenshot`'s full-screen branch from Task 5.
- Produces: `STORAGE_KEYS.FULL_SCREEN_CAPTURE_HINT = "full_screen_capture_hint"` holding `"seen"` once shown; a DOM element with `data-slot="capture-hint"` inside a `data-hud-overlay` bar.

This is TASK-2 acceptance criterion #2. There is no toast primitive in the repo (`src/components/ui/` has no sonner, no toast). The pattern to copy is `data-slot="history-notice"` at `Input.tsx:549`, and the `data-hud-overlay` attribute that keeps a transient bar from growing the native window (`Input.tsx:155` explains why).

- [ ] **Step 1: Write the failing test**

Append to `dev-harness/probe.mjs`:

```js
  // 1d. the whole-screen path warns once, on its own page.
  //
  // Someone who deliberately chose Screenshot Mode keeps it, so the only honest
  // mitigation is telling them what it costs: a native-resolution capture is
  // transcribed to about 60% and then stops without saying so.
  const hintPage = await context.newPage();
  watchForErrors(hintPage, "capture-hint");
  await hintPage.setViewportSize({ width: HUD_WIDTH, height: 320 });
  await hintPage.addInitScript(() => {
    try {
      localStorage.setItem(
        "screenshot_config",
        JSON.stringify({
          mode: "manual",
          autoPrompt: "Analyze this screenshot and provide insights",
          enabled: true,
        })
      );
    } catch {
      // Storage disabled just means this assertion is the loss.
    }
  });
  await hintPage.goto(APP_URL, { waitUntil: "domcontentloaded" });
  const hintPrompt = hintPage.getByPlaceholder(PROMPT_PLACEHOLDER);
  await hintPrompt.waitFor({ state: "visible", timeout: 15000 });
  await hintPage.locator('[data-slot="hud-screenshot"]').click();
  await hintPage.waitForTimeout(600);

  const hint = await hintPage.evaluate(() => {
    const node = document.querySelector('[data-slot="capture-hint"]');
    const bar = node?.closest("[data-hud-overlay]");
    return {
      present: Boolean(node),
      text: node?.textContent?.trim() ?? null,
      insideOverlay: Boolean(bar),
      overflows: bar ? bar.scrollWidth > bar.clientWidth + 0.5 : null,
      flag: localStorage.getItem("full_screen_capture_hint"),
    };
  });
  await hintPage.screenshot({ path: join(OUT, "8-capture-hint.png") });
  record(
    "a whole-screen capture warns once and the bar fits",
    hint.present &&
      hint.insideOverlay &&
      hint.overflows === false &&
      hint.flag === "seen" &&
      /region/i.test(hint.text ?? ""),
    `present=${hint.present} inOverlay=${hint.insideOverlay} ` +
      `overflows=${hint.overflows} flag=${hint.flag ?? "(unset)"} ` +
      `text=${JSON.stringify(hint.text)}`
  );
```

`dev-harness/tauri-mock.js` must return a base64 string from `capture_to_base64` for the click to reach the notice. Check what it currently returns for that command and, if it is unhandled, add a short canned base64 PNG — otherwise the assertion fails for the wrong reason.

- [ ] **Step 2: Run the probe to verify it fails**

Two shells (`npm run dev`, then):

Run: `npm run hud:probe`
Expected: FAIL on `a whole-screen capture warns once and the bar fits` with `present=false flag=(unset)`. Total 25 assertions.

- [ ] **Step 3: Add the storage key**

In `src/config/constants.ts`, inside `STORAGE_KEYS`:

```ts
  FULL_SCREEN_CAPTURE_HINT: "full_screen_capture_hint",
```

- [ ] **Step 4: Set the flag on the full-screen branch**

In `src/hooks/useCompletion.ts`, in the `config.enabled && !forceRegion` branch of `captureScreenshot`, before the `invoke`:

```ts
        // Told once, then never again. A capture is not the moment for a lecture,
        // but silently reading 60% of the screen is worse.
        if (
          safeLocalStorage.getItem(STORAGE_KEYS.FULL_SCREEN_CAPTURE_HINT) !==
          "seen"
        ) {
          safeLocalStorage.setItem(
            STORAGE_KEYS.FULL_SCREEN_CAPTURE_HINT,
            "seen"
          );
          setShowCaptureHint(true);
        }
```

Add `const [showCaptureHint, setShowCaptureHint] = useState(false);` to the hook's state and expose `showCaptureHint` / `setShowCaptureHint` on its return object and on `UseCompletionReturn` in `src/types/completion.hook.ts`. Mirror the same block in `useChatCompletion.ts`.

- [ ] **Step 5: Render the notice**

In `src/pages/app/components/completion/Input.tsx`, next to the `data-slot="history-notice"` element at line 549, add:

```tsx
{showCaptureHint && (
  <div
    data-hud-overlay
    className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
  >
    <span data-slot="capture-hint" className="truncate">
      Whole-screen captures lose detail. Drag a region for accurate reading.
    </span>
    <Button
      size="sm"
      variant="ghost"
      data-slot="capture-hint-dismiss"
      onClick={() => setShowCaptureHint(false)}
    >
      Got it
    </Button>
  </div>
)}
```

Destructure `showCaptureHint` and `setShowCaptureHint` from the props alongside the other completion fields.

- [ ] **Step 6: Run the probe to verify it passes**

Run: `npm run hud:probe`
Expected: PASS 25/25. Re-run once on a cold-start flake.

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit -p /Users/tessaro/omni/tsconfig.json`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git -C /Users/tessaro/omni add src/config/constants.ts src/hooks/useCompletion.ts src/hooks/useChatCompletion.ts src/types/completion.hook.ts src/pages/app/components/completion/Input.tsx dev-harness/probe.mjs dev-harness/tauri-mock.js
git -C /Users/tessaro/omni commit -m "feat(capture): warn once that a whole-screen grab loses detail"
```

---

### Task 7: An eval that measures the mode the app now defaults to

**Files:**
- Modify: `evals/tasks/vision.tasks.ts` (add one task next to `vision-full-screen-capture-tail` at lines 54-76)
- Modify: `evals/README.md` (the stale "Grading philosophy" lines 154-161 and "Baseline" table lines 199-211)
- Create: `evals/fixtures/vision/vscode-web-region-1440x900.png` and `.visible.txt`

**Interfaces:**
- Consumes: nothing.
- Produces: a `vision-region-capture-tail` task with a `substring` grader, so `npm run eval:run` scores both capture modes on the same question.

This is TASK-2 acceptance criterion #3, taking the "or is replaced by a region-capture equivalent" branch. `vision-full-screen-capture-tail` is kept: it is the documented failure and it must stay red until the model improves, not be deleted because the app now avoids it. What is missing is a green counterpart proving the default the app now ships actually reads.

- [ ] **Step 1: Generate the fixture**

`dev-harness/ide-capture.mjs` is the existing generator and records the ground-truth visible text alongside the PNG. Use the same page the full-screen fixture used, at the resolution the region path produces:

```bash
node /Users/tessaro/omni/dev-harness/ide-capture.mjs \
  --url "<the same URL used for vscode-web-fullscreen-2560x1600>" \
  --out vscode-web-region-1440x900 \
  --viewport 1440x900 \
  --scale 1
```

Read the top comment of `ide-capture.mjs` for the exact flag names and where it writes, and confirm both the `.png` and the `.visible.txt` landed in `evals/fixtures/vision/`.

- [ ] **Step 2: Write the failing task**

Add to `evals/tasks/vision.tasks.ts`, after the existing task at lines 54-76:

```ts
  {
    id: "vision-region-capture-tail",
    category: "vision",
    title: "Read the bottom of a region capture",
    prompt:
      "This is a screenshot of a 1440x900 region containing a source file open in " +
      "an editor. Find the class definition furthest down the visible file and quote " +
      "its `__attrs__` list exactly as written, then quote the first parameter of its " +
      "`__init__` signature.",
    imageFixtures: [
      "evals/fixtures/vision/vscode-web-region-1440x900.png",
    ],
    grader: {
      type: "substring",
      expectedAll: ["_pool_block", "DEFAULT_POOLSIZE"],
      caseSensitive: true,
    },
    knownWeakness:
      "None measured. This is the counterpart to vision-full-screen-capture-tail " +
      "and the mode the app now defaults to: the same question, the same file, at " +
      "the resolution a dragged region produces, where transcription measures 0-1.7% " +
      "character error instead of stopping at about 60%. If this one starts failing " +
      "too, the problem is not the capture size.",
  },
```

Adjust `expectedAll` to match whatever the generated `.visible.txt` actually shows at the bottom of the 1440x900 viewport — the strings above are the full-screen fixture's, and a smaller viewport shows fewer lines. Read the generated ground truth and pick two literals from the last visible class.

- [ ] **Step 3: Verify the task is well-formed without spending money**

Run: `npm run eval:typecheck`
Expected: PASS.

Run: `npm run eval:dry-run -- --task vision-region-capture-tail`
Expected: the request Omni would send is printed, including the base64 image, with no network call. A missing fixture throws here (`evals/harness/runTask.ts:15-27`), so this is the check that the path is right.

- [ ] **Step 4: Score both modes against a real provider**

This costs money and needs a key, and is deliberately not in CI.

```bash
export OMNI_EVAL_PROVIDER=gemini
export OMNI_EVAL_API_KEY=<key>
npm run eval:run -- --task vision-region-capture-tail,vision-full-screen-capture-tail --show-response
```

Expected: `vision-region-capture-tail` PASS, `vision-full-screen-capture-tail` FAIL. Record both results in the commit body. If the region task also fails, stop and report — the premise the capture fix rests on is wrong, and Task 4's default change needs revisiting rather than papering over.

- [ ] **Step 5: Correct the stale README**

In `evals/README.md`, the "Grading philosophy" section (lines 154-161) and the "Baseline" table (lines 199-211) still describe vision tasks as unautomated with "3 skipped, no fixtures". They have real fixtures and `substring` graders now. Update both to the current state and add the measured pass/fail from Step 4 to the baseline table.

- [ ] **Step 6: Commit**

```bash
git -C /Users/tessaro/omni add evals/tasks/vision.tasks.ts evals/fixtures/vision/ evals/README.md
git -C /Users/tessaro/omni commit -m "test(evals): score region capture against the full-screen failure"
```

---

### Task 8: Code blocks scroll instead of wrapping into fake newlines

**Files:**
- Modify: `src/tailwind.css:208-214`
- Modify: `dev-harness/probe.mjs` (one assertion)

**Interfaces:**
- Consumes: nothing.
- Produces: `[data-streamdown="code-block"] pre` computes `white-space: pre` and scrolls horizontally, matching the behaviour `[data-streamdown="table"]` already has.

This is TASK-3, both acceptance criteria. The rule at lines 202-206 sets `overflow-x: auto` on the wrapper for code blocks and tables alike, but the rule at 208-213 then puts `white-space: pre-wrap` and `word-wrap: break-word` on the `pre` and `code` themselves, so a long line wraps inside the 600px window instead of ever becoming wide enough to scroll. A continuation row starts at the gutter's left edge with no hanging indent, so it is indistinguishable from a real line break — in a HUD whose usable code width is roughly 55-60 characters at Streamdown's own `text-sm` in Geist Mono, that is most non-trivial lines. Tables have no `white-space` override, which is why they scroll and code does not.

The fix is to stop wrapping rather than to mark the wrap. A marked wrap still forces the reader to distinguish two kinds of line ending in code they may be about to copy; real horizontal scroll removes the ambiguity instead of annotating it, and makes code consistent with the tables beside it.

- [ ] **Step 1: Write the failing test**

Append to `dev-harness/probe.mjs`. This measures the shipped stylesheet against a code block in the real document, at the real HUD width, in the WebKit engine the app ships in — the app's own response panel needs a provider and a network call, which this probe deliberately does without:

```js
  // 10. a long code line scrolls; it does not wrap into a fake newline.
  //
  // `white-space: pre-wrap` on the pre meant overflow-x: auto never engaged, so a
  // wrapped continuation row began at the gutter's left edge with no hanging
  // indent. In a 600px HUD that is most real lines, and the reader cannot tell a
  // wrap from a newline in code they are about to copy. Tables already scrolled.
  const codeWrap = await page.evaluate(() => {
    const host = document.createElement("div");
    host.setAttribute("data-streamdown", "code-block");
    const pre = document.createElement("pre");
    pre.setAttribute("data-streamdown", "code-block-body");
    pre.className = "p-4 text-sm";
    const code = document.createElement("code");
    code.textContent =
      "const x = someFunction(argumentOne, argumentTwo, argumentThree, argumentFour, argumentFive);";
    pre.appendChild(code);
    host.appendChild(pre);
    document.body.appendChild(host);
    const style = getComputedStyle(pre);
    const measured = {
      whiteSpace: style.whiteSpace,
      overflowX: style.overflowX,
      scrolls: pre.scrollWidth > pre.clientWidth + 0.5,
      scrollWidth: pre.scrollWidth,
      clientWidth: pre.clientWidth,
      lineBoxes: code.getClientRects().length,
    };
    host.remove();
    return measured;
  });
  record(
    "a long code line scrolls instead of wrapping",
    codeWrap.whiteSpace === "pre" &&
      codeWrap.scrolls &&
      codeWrap.lineBoxes === 1,
    `white-space=${codeWrap.whiteSpace} overflow-x=${codeWrap.overflowX} ` +
      `scrollWidth=${codeWrap.scrollWidth} clientWidth=${codeWrap.clientWidth} ` +
      `lineBoxes=${codeWrap.lineBoxes} (want 1)`
  );
```

- [ ] **Step 2: Run the probe to verify it fails**

Two shells (`npm run dev`, then):

Run: `npm run hud:probe`
Expected: FAIL on `a long code line scrolls instead of wrapping`, with detail showing `white-space=pre-wrap`, `lineBoxes=2` (or more), and `scrollWidth` equal to `clientWidth`. Total 26 assertions.

- [ ] **Step 3: Change the CSS**

Replace `src/tailwind.css:208-214`:

```css
[data-streamdown="code-block"] pre,
[data-streamdown="code-block"] code {
  max-width: 100% !important;
  overflow-x: auto !important;
  word-wrap: break-word !important;
  white-space: pre-wrap !important;
}
```

with:

```css
/* Code scrolls, it does not wrap. `pre-wrap` here meant the overflow-x above
   never engaged, and a wrapped continuation row started at the gutter's left
   edge with no hanging indent — indistinguishable from a real newline in code
   the reader is about to copy. The HUD is 600px, so that was most lines.
   Tables in the rule above already behave this way. */
[data-streamdown="code-block"] pre,
[data-streamdown="code-block"] code {
  max-width: 100% !important;
  overflow-x: auto !important;
  white-space: pre !important;
}
```

`word-wrap: break-word` is dropped rather than kept: with `white-space: pre` it cannot fire on a long token, and leaving a dead declaration next to the rule it used to break invites the next reader to restore the wrap.

- [ ] **Step 4: Run the probe to verify it passes**

Run: `npm run hud:probe`
Expected: PASS 26/26, with detail showing `white-space=pre`, `lineBoxes=1`, and `scrollWidth` greater than `clientWidth`. Re-run once on a cold-start flake.

- [ ] **Step 5: Look at it**

`npm run hud:probe` writes screenshots to `dev-harness/out/`. Open the newest ones and confirm the code block did not lose its rounded border or start clipping its copy control — the wrapper's `overflow-x: auto` at line 202-206 is unchanged, but Streamdown's own default on that element is `overflow-hidden`, so this is the pairing worth eyeballing once.

- [ ] **Step 6: Verify the build**

Run: `npm run build`
Expected: PASS. Tailwind v4 processes `tailwind.css` at build time, so a malformed rule surfaces here.

- [ ] **Step 7: Commit**

```bash
git -C /Users/tessaro/omni add src/tailwind.css dev-harness/probe.mjs
git -C /Users/tessaro/omni commit -m "fix(hud): scroll long code lines instead of wrapping them"
```

---

## Closing out

- [ ] **Run every gate CI runs, in one pass**

```bash
npx tsc --noEmit -p /Users/tessaro/omni/tsconfig.json
npm run eval:typecheck
npm run check:commands
npm run eval:test
npm run eval:dry-run
npm run build
cargo check --manifest-path /Users/tessaro/omni/src-tauri/Cargo.toml
cargo test --manifest-path /Users/tessaro/omni/src-tauri/Cargo.toml
cargo clippy --manifest-path /Users/tessaro/omni/src-tauri/Cargo.toml --all-targets -- -D warnings
npm audit --audit-level=high
```

Then, with `npm run dev` running in another shell: `npm run hud:probe` (expect 26/26).

- [ ] **Mark the three backlog tasks Done**

`backlog/config.yml` sets `statuses: ["To Do", "In Progress", "Done"]` and `auto_commit: false`. Set `status: Done` in the frontmatter of all three task files and tick their acceptance criteria, then commit them with the branch. Note in TASK-4's file that acceptance criterion #2 was met via the two-layer approach described at the top of this plan, since "answers containing code" is not knowable before the answer exists.

- [ ] **Open the PR**

```bash
git -C /Users/tessaro/omni push -u origin fix/code-answer-fidelity
gh pr create --repo connortessaro/omni --base main \
  --title "fix: code answers survive capture, prompt, and rendering" \
  --body "Closes TASK-2, TASK-3, TASK-4. See docs/superpowers/plans/2026-08-21-code-answer-fidelity.md."
```

Include the Task 7 Step 4 eval numbers in the PR body — they are the only measurement in this branch that a reviewer cannot reproduce for free.

---

## Self-Review

**Spec coverage.**

| Spec criterion | Task |
|---|---|
| TASK-2 #1 — region selection reachable without opening settings | Task 5 (dedicated `cmd+shift+d` shortcut, works regardless of saved mode) |
| TASK-2 #2 — a full-screen capture tells the user, once, that region reads better | Task 6 |
| TASK-2 #3 — `vision-full-screen-capture-tail` passes or is replaced by a region equivalent | Task 7 (adds the equivalent, keeps the original as the documented failure) |
| TASK-2 root cause — default is full screen | Task 4 (and the un-ticketed half: the broken one-time migration) |
| TASK-3 #1 — a wrapped code line is visually distinguishable from a line break | Task 8 (removes the wrap entirely, so there is no continuation row to distinguish) |
| TASK-3 #2 — a probe assertion covers it | Task 8 Step 1 |
| TASK-4 #1 — a code-oriented system prompt exists and is selectable | Task 3 |
| TASK-4 #2 — response-length caps do not apply to answers containing code | Tasks 1 + 2, under the assumption stated at the top |

No spec requirement is unassigned.

**Placeholder scan.** Three steps ask the executor to locate something rather than giving a line number, each because the target moves as earlier steps in the same task edit the file, or because the exact name could not be confirmed without reading a file that a parallel agent was holding: Task 3 Step 6 (the `setPrompts` call in `useSystemPrompts.ts`), Task 3 Step 7 (the card action buttons in `system-prompts/index.tsx`), Task 5 Step 1 (`default_shortcuts()`, whose real accessor name the three existing tests in that module already use). Each is paired with an assertion or a failing test that makes a wrong guess visible. Task 7 Step 1 leaves the source URL to be read from the existing fixture's generation comment, and Step 2 explicitly requires `expectedAll` to be re-derived from the generated ground truth rather than copied.

**Type consistency.** `codeIntent` is the field name in all four places it appears: `fetchAIResponse`'s params (Task 2 Step 3), the harness mirror `FetchAIResponseParams` (Task 2 Step 4), `buildEnhancedSystemPrompt`'s third parameter (Task 2 Step 3), and both call branches in `useCompletion.ts` (Task 2 Step 6, extended in Task 3 Step 8). `CODE_PROFILE_ID` is defined in Task 3 Step 4 and consumed in Task 3 Step 8. `isBuiltinSystemPrompt` is defined in Task 3 Step 4 and consumed in Steps 6 and 7. `forceRegion` is defined in Task 5 Step 6 and consumed in Task 6 Step 4's branch condition. `STORAGE_KEYS.FULL_SCREEN_CAPTURE_HINT` is defined in Task 6 Step 3 and consumed in Steps 4 and 1 (the probe reads the raw string `"full_screen_capture_hint"`, which matches). `sendAndCaptureBody` is exported in Task 1 Step 1 and consumed in Task 2 Step 1.

**Probe assertion count.** 23 shipped → 24 after Task 4 → 25 after Task 6 → 26 after Task 8. Any step that reports a different total means an assertion was added twice or lost.
