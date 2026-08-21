# Omni eval harness

Scores Omni's answer quality on problem-solving tasks by driving Omni's real
request-assembly code (`src/lib/functions/ai-response.function.ts`,
`fetchAIResponse`) end to end — system-prompt stacking, history formatting,
variable substitution, and streaming parse all included — against a
committed task set, then grades the output deterministically.

## Why this exists

There was no way to tell whether a change to prompts, providers, or the
request pipeline made Omni better or worse at solving hard problems. This
harness is a repeatable, scriptable answer to that: run it before and after a
change and compare the pass rate.

## How it drives Omni's real code (not a reimplementation)

`fetchAIResponse` lives in `src/` and imports `@/lib` (path-aliased) and
`@tauri-apps/plugin-http`. Two things make it possible to call the *exact*
production function from a plain Node script:

1. **The path alias is resolved by bundling, not by rewriting the import.**
   `evals/harness/loadSrcModule.ts` uses esbuild's Node API to bundle a
   single file straight out of `src/`, pointing it at the repo's own
   `tsconfig.json` so `@/*` resolves exactly the way Vite resolves it for the
   real app. Real npm packages (`@tauri-apps/*`, `@bany/curl-to-json`) are
   left external and resolved by Node from `node_modules` as usual. Zero
   files under `src/` are read, aliased away, or modified.

2. **No Tauri stub is needed for the transport.** Every provider shipped in
   `src/config/ai-providers.constants.ts` targets a plain `http(s)://` URL,
   and `fetchAIResponse` itself already picks `url.includes("http") ? fetch
   : tauriFetch` — so for every real provider it calls the ambient global
   `fetch`, never the Tauri plugin. `@tauri-apps/plugin-http` (and
   `@tauri-apps/plugin-sql`, `@tauri-apps/api/core`, used elsewhere in the
   `@/lib` barrel for the local DB and app version) only touch Tauri's IPC
   bridge *inside function bodies that fetchAIResponse never calls* — so
   importing the module is safe in Node with no source changes and no stub
   modules at all.

   That leaves exactly one seam to control: the global `fetch` the code
   already reads. `evals/harness/fakeGlobals.ts` reassigns
   `globalThis.fetch` before calling into the bundled function — for a dry
   run it's a capturing stub that records the request and returns a canned
   response (no network I/O); for a live run it's simply left as the real
   `fetch`. This is dependency injection through the language's own global
   lookup, not a mock of any module.

   `localStorage` (read by `getResponseSettings()` for the response-length
   and language settings that feed `buildEnhancedSystemPrompt`) doesn't
   exist in Node either; `evals/harness/fakeGlobals.ts` installs a tiny
   in-memory implementation so those settings are explicit and reproducible
   instead of silently falling back through a caught exception.

**Net production-code diff: zero.** Nothing under `src/` was read-aliased,
mocked, or edited. The only "seams" used are ones the code already exposes:
the `fetch` global and the `signal`/`history`/`systemPrompt` parameters
`fetchAIResponse` already accepts.

This is why the dry run (see below) shows the *actual* system prompt Omni
assembles, the *actual* message array `buildDynamicMessages` produces
(including how it splices prior turns from `history`), and the *actual*
streamed-text reconstruction from `getStreamingContent`/`getByPath` — all
without a network connection.

## Layout

```
evals/
  types.ts                    Task / Grader shared types
  tasks/                       committed task data (the eval "dataset")
    coding.tasks.ts             8 LeetCode-style tasks, executably graded
    debugging.tasks.ts          6 broken-code-plus-symptom tasks
    reasoning.tasks.ts          6 math/word problems, numeric answers
    long-context.tasks.ts       4 tasks pasting 300+ line synthetic files
    longContextFixtures.ts      deterministic generators for those files
    vision.tasks.ts             3 tasks describing (not automating) vision grading
    index.ts                    ALL_TASKS
  graders/                      deterministic, no LLM judge
    codeExec.ts                 extracts code, runs it in a subprocess, diffs vs. expected
    debugFix.ts                 codeExec + a root-cause keyword check
    numeric.ts                  extracts "Final answer: <n>", compares with tolerance
    substring.ts                checks a set of required facts are present
    index.ts                    dispatches Task -> grader by grader.type
    *.test.ts                   unit tests against hand-written fake model outputs
  harness/
    loadSrcModule.ts             esbuild-bundles a file from src/ and imports it
    providerConfig.ts            reads OMNI_EVAL_* env, loads the real AI_PROVIDERS
    fakeGlobals.ts                localStorage shim + capturing/canned fetch
    runTask.ts                   drives one Task through fetchAIResponse end to end
  scripts/
    dry-run.ts                   no key needed: prints the exact request bodies Omni
                                  would send, with zero network calls
    run-eval.ts                  needs a real key: runs the task set live and grades it
```

## Running it

```bash
npm run eval:typecheck   # tsc -p evals/tsconfig.json (strict)
npm run eval:test        # node --test evals/graders/*.test.ts (grader unit tests)
npm run eval:dry-run     # no key needed — proves the request assembly end to end
npm run eval:run         # needs OMNI_EVAL_PROVIDER + OMNI_EVAL_API_KEY
```

`eval:dry-run` accepts `--all` (every task) or `--task <id,id,...>`; default
is a small representative sample. `eval:run` accepts `--category <cat>` or
`--task <id,id,...>` to filter.

### Running it live

```bash
export OMNI_EVAL_PROVIDER=openai        # one of the ids in src/config/ai-providers.constants.ts
export OMNI_EVAL_API_KEY=sk-...
export OMNI_EVAL_MODEL=gpt-4o-mini      # optional; each provider has a placeholder default
npm run eval:run
```

If `OMNI_EVAL_PROVIDER`/`OMNI_EVAL_API_KEY` are missing, unset, or name an
unknown provider, `eval:run` prints exactly what's missing and exits with a
non-zero code. It never fakes a result and never hangs — the only exception
to needing `OMNI_EVAL_API_KEY` is `OMNI_EVAL_PROVIDER=ollama` against a local
server, and even then a dead/absent Ollama just surfaces as a normal
per-task network-error result, not a hang (each task run is wrapped in
`AbortSignal.timeout(60000)`, using `fetchAIResponse`'s own existing
`signal` parameter).

Model catalogs move faster than this README; if the default model 404s for
your account, set `OMNI_EVAL_MODEL` explicitly.

## Grading philosophy

- **Coding and debugging tasks are executably graded.** The model's fenced
  code block is extracted, run in a real (short-timeout) Node subprocess
  against hand-computed test cases, and compared with
  `assert.deepStrictEqual`. No LLM judge, no partial credit for "looks
  right."
- **Debugging tasks additionally require the root cause to be named** (a
  keyword/phrase check on the explanation text) — a syntactically-working
  fix with no correct diagnosis, or a correct diagnosis with a fix that
  doesn't actually pass, both fail. `evals/graders/debugFix.test.ts` exercises
  both of those partial-credit traps directly.
- **Reasoning tasks require a literal `Final answer: <number>` line**, parsed
  and compared with an explicit tolerance. This is a deliberate, disclosed
  constraint on the model's output format in exchange for a grader that
  never needs to parse prose.
- **Long-context tasks are substring checks against a fact planted in the
  middle of a 300+ line generated document** (a config value, a log line, a
  buried transcript detail, a specific function's return value). Two of the
  four splice the document into `history` and ask the question as a
  follow-up turn; the other two paste-and-ask in one message — both of
  `buildDynamicMessages`'s branches (spreading prior `history` verbatim vs.
  templating the current turn) get exercised, not just one.
- **Vision tasks are automated.** They were not, when this file first
  described them: they carried `manual` graders that `run-eval.ts` skips, and
  `runTaskAgainstOmni` never passed `imagesBase64`, so the vision path shipped
  with no executed coverage at all. They now use real fixtures checked in under
  `evals/fixtures/vision/`, captured from psf/requests open in VS Code for the
  web by `dev-harness/ide-capture.mjs`, which records the on-screen DOM text
  next to each PNG as ground truth. Grading is the same deterministic
  `substring` approach as everywhere else, on strings that are in the fixture
  and are not guessable from the prompt: vendored urllib3 import paths and the
  file's own constant names.
- **Two of them are a controlled pair, not duplicates.**
  `vision-full-screen-capture-tail` and `vision-region-capture-tail` ask the
  same shape of question about the bottom of the same file, at the two
  resolutions Omni's two capture modes actually produce. That pair is the
  measurement the capture default rests on, so it is meant to stay
  asymmetric: the full-screen one is a documented known failure and will keep
  the suite below its pass bar until models improve. That is the signal, not a
  regression.

## Every task's expected answer is verified against a real solution

`gradeCodeExec`/`gradeDebugFix` are also how you'd catch a mistake in the
task data itself, not just in a model's answer — every coding and debugging
task's expected values were checked by writing a correct reference
implementation for each and running it through the actual grader before
trusting the numbers (this is exactly what `eval:test` encodes as permanent
regression coverage for the graders; the ad hoc reference-solution sweep used
while authoring the task set was scratch-only and isn't part of the
committed harness).

## Known gaps

- **Vision and audio are not scored end to end here** — see "Vision tasks"
  above. Extending this harness with real fixture images and an LLM-judge
  grader is the natural next step, not a redesign.
- **No live run has ever been executed against a real provider** on this
  machine (no API key, no local Ollama). The request-assembly path is proven
  end to end via `eval:dry-run`; the network call itself is exactly one line
  of `fetchAIResponse` (`await fetchFunction(url, {...})`) that this harness
  intentionally does not touch.
- **The numeric and long-context graders trust the model to follow an output
  format instruction** (`Final answer: <n>`, or just "answer with the
  number"). A model that ignores formatting instructions entirely will fail
  the grader even if its reasoning was correct — that's a real product
  signal (Omni's system prompt should be making formatting instructions
  stick), not a grading bug, but it means a regression here can mean either
  "got the wrong answer" or "stopped following instructions." The per-task
  summary line distinguishes the two (`no "Final answer: <number>" line
  found` vs. `extracted X, expected Y`).
- **Code-exec grading only covers JavaScript.** Every coding/debugging task
  prompt explicitly asks for JavaScript so the sandboxed runner (plain
  `node <file>.cjs`, 5s timeout) can execute it directly with no extra
  toolchain. Extending to other languages means adding a runner per
  language, not changing the grading model.

## Baseline

First live run, 2026-08-19, `gemini-2.5-flash` via the shipped `gemini`
provider (Google's OpenAI-compatible endpoint):

| category | score |
|---|---|
| coding | 8/8 |
| debugging | 6/6 |
| reasoning | 6/6 |
| long-context | 4/4 |
| vision | 3 skipped, no fixtures |
| **automated total** | **24/24** |

Vision re-run, 2026-08-21, same provider, after the fixtures and graders landed
and `capture_to_base64` stopped being the default capture path:

| task | result | latency |
|---|---|---|
| vision-region-capture-tail | PASS | 3664ms |
| vision-full-screen-capture-tail | FAIL, `missing: DEFAULT_POOLSIZE` | 6156ms |

That is the whole argument for defaulting to region capture, in two lines: asked
the same shape of question about the bottom of the same file, the model answers
it from a 1440x900 region and does not answer it from a 2560x1600 full screen.
The full-screen capture is also the slower of the two, so the larger image buys
nothing. Neither number is a regression to chase; the pair is the instrument.

Read that number with suspicion rather than satisfaction. **A suite that scores
100% on its first run has no headroom**, so it cannot currently distinguish a
real regression from noise, and it says more about the tasks being too easy for
a current model than about Omni. Two things it did prove: Omni's production
request path works end to end against a real provider, and generated code
survives execution against test cases.

Run-to-run variance is real. Three consecutive full runs scored 23/24, 23/24,
and 24/24 with no code changes between the last two, so a single failing task is
not by itself evidence of anything. Compare distributions, not single runs.

To make this suite useful, tasks need to get harder until the score lands
somewhere in the 60-80% range, where movement is informative.

## Running it with a key

The runner reads `OMNI_EVAL_PROVIDER`, `OMNI_EVAL_API_KEY`, and optionally
`OMNI_EVAL_MODEL`. Keep the credential in a mode-600 file outside the repo and
source it, so it never lands in shell history or a tracked file:

```bash
# ~/.config/omni/eval.env, chmod 600
OMNI_EVAL_PROVIDER=gemini
OMNI_EVAL_API_KEY=...
```

```bash
set -a; . ~/.config/omni/eval.env; set +a
npm run eval:run                                  # everything
npm run eval:run -- --category debugging          # one category
npm run eval:run -- --task debug-missing-await --show-response
```

`--show-response` prints what the model actually said. Reach for it whenever a
task fails: a grader failing for the wrong reason is worse than no grader, and
that is exactly what happened on the first run. `debug-lexicographic-sort` was
scored a miss for a completely correct answer, because the keyword list demanded
the literal phrase "string sort" while the model wrote "sorts elements as
strings by default". Keyword entries now accept an array of terms that must
co-occur, so a concept can be matched without pinning one phrasing.

This suite is deliberately **not** in CI: it costs money per run and needs a
credential. CI runs the graders, the harness unit tests, and the request-assembly
dry run, all of which are free and deterministic.
