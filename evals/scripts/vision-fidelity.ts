// Scores how much of a screenshot's code a model can actually read.
//
// Omni's only view of a repo in a browser IDE is a screenshot, so "can it read the
// screen" is not a detail, it is the whole capability. This turns that into a
// character error rate against the text that was provably on screen when the
// capture was taken (dev-harness/ide-capture.mjs writes it alongside the PNG).
//
// Goes through the real fetchAIResponse, so the provider's own image encoding,
// system-prompt stacking and streaming parse are all in the path.
//
// Usage: OMNI_EVAL_PROVIDER=gemini OMNI_EVAL_API_KEY=... \
//          node evals/scripts/vision-fidelity.ts \
//            --image dev-harness/out/ide/github-adapters/full-2x.png \
//            --truth dev-harness/out/ide/github-adapters/visible-2x.txt

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadSrcModule } from "../harness/loadSrcModule.ts";
import {
  resolveProviderFromEnv,
  MissingEvalCredentialsError,
} from "../harness/providerConfig.ts";
import { installMemoryLocalStorage } from "../harness/fakeGlobals.ts";
import type { FetchAIResponseParams } from "../harness/runTask.ts";

interface AiModule {
  fetchAIResponse(params: FetchAIResponseParams): AsyncIterable<string>;
}

const TRANSCRIBE_PROMPT =
  "This is a screenshot of a source file open in a code editor in a web browser. " +
  "Transcribe every line of code that is visible, verbatim, preserving order. " +
  "Output only the code, with no commentary, no line numbers, and no markdown fences.";

const parseArgs = (argv: string[]) => {
  let image: string | undefined;
  let truth: string | undefined;
  let label: string | undefined;
  let prompt: string | undefined;
  let truthLines: [number, number] | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--image") { image = argv[i + 1]; i++; }
    else if (argv[i] === "--truth") { truth = argv[i + 1]; i++; }
    else if (argv[i] === "--label") { label = argv[i + 1]; i++; }
    else if (argv[i] === "--prompt") { prompt = argv[i + 1]; i++; }
    else if (argv[i] === "--truth-lines") {
      const [from, to] = argv[i + 1].split("-").map(Number);
      if (!from || !to || to < from) {
        console.error(`--truth-lines wants 1-based from-to, got "${argv[i + 1]}"`);
        process.exit(2);
      }
      truthLines = [from, to];
      i++;
    }
  }

  if (!image || !truth) {
    console.error(
      "Usage: node evals/scripts/vision-fidelity.ts --image <png> --truth <txt> " +
        "[--label name] [--prompt text] [--truth-lines from-to]"
    );
    process.exit(2);
  }
  return {
    image: resolve(image),
    truth: resolve(truth),
    label: label ?? image,
    prompt,
    truthLines,
  };
};

/**
 * Compares what was read, not how it was formatted: indentation and blank lines are
 * layout, and a model asked for "verbatim" still reflows them. Line numbers are
 * stripped because they are visible in the screenshot but not part of the file.
 */
const normalize = (text: string): string =>
  text
    .replace(/```[a-zA-Z]*\n?/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\s+/, "").trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0)
    .join("\n");

/** Levenshtein distance, two rows rather than a full matrix. */
const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, previous[j] + 1, current[j - 1] + 1);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
};

const main = async () => {
  const { image, truth, label, prompt, truthLines } = parseArgs(process.argv.slice(2));

  let resolved;
  try {
    resolved = await resolveProviderFromEnv();
  } catch (error) {
    if (error instanceof MissingEvalCredentialsError) {
      console.error(`\nCannot run: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  const { provider, selectedProvider } = resolved;

  installMemoryLocalStorage({
    response_settings: JSON.stringify({
      responseLength: "auto",
      language: "english",
      autoScroll: true,
    }),
  });

  const omni = await loadSrcModule<AiModule>("lib/functions/ai-response.function.ts");

  const png = readFileSync(image);

  // A line range lets the same image be scored on a slice of itself, which is how
  // you tell an unreadable capture apart from one the model simply stopped reading.
  const truthText = readFileSync(truth, "utf8");
  const expected = normalize(
    truthLines
      ? truthText.split("\n").slice(truthLines[0] - 1, truthLines[1]).join("\n")
      : truthText
  );

  const startedAt = Date.now();
  let response = "";
  let errorText: string | undefined;
  try {
    for await (const chunk of omni.fetchAIResponse({
      provider,
      selectedProvider,
      userMessage: prompt ?? TRANSCRIBE_PROMPT,
      history: [],
      imagesBase64: [png.toString("base64")],
      signal: AbortSignal.timeout(180_000),
    })) {
      response += chunk;
    }
  } catch (error) {
    errorText = error instanceof Error ? error.message : String(error);
  }
  const durationMs = Date.now() - startedAt;

  if (errorText) {
    console.log(`${label}: FAILED after ${durationMs}ms`);
    console.log(`  ${errorText}`);
    process.exit(1);
  }

  const got = normalize(response);
  const distance = editDistance(expected, got);
  const cer = expected.length === 0 ? 1 : distance / expected.length;

  const expectedLines = expected.split("\n");
  const gotLines = new Set(got.split("\n"));
  const exactLines = expectedLines.filter((line) => gotLines.has(line)).length;

  console.log(`${label}`);
  console.log(`  image            ${(png.length / 1024).toFixed(0)}KB PNG`);
  console.log(`  latency          ${durationMs}ms`);
  console.log(`  expected chars   ${expected.length}`);
  console.log(`  returned chars   ${got.length}`);
  console.log(`  edit distance    ${distance}`);
  console.log(`  CER              ${(cer * 100).toFixed(1)}%`);
  console.log(
    `  exact lines      ${exactLines}/${expectedLines.length} ` +
      `(${((exactLines / expectedLines.length) * 100).toFixed(0)}%)`
  );

  process.stdout.write("\n--- returned\n" + response.trimEnd() + "\n");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
