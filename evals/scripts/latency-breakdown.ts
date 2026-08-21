// Where the time before the first token goes, measured instead of guessed.
//
// The only latency numbers on record came from `eval:run`: 3664ms for a turn
// carrying a 1440x900 region capture, 6156ms for the same question against a
// 2560x1600 full screen. Both are end-to-end totals against a live provider, so
// they cannot say whether the extra 2.5 seconds was the network carrying a bigger
// image or Omni spending it before the request left the process.
//
// This separates the two. `fetch` is replaced with a stub that returns
// immediately, so everything measured here is Omni's own work: parsing the
// provider's curl template, building the messages array, substituting variables,
// and serialising the body. Whatever this reports is latency the user pays on
// every single turn and no provider choice can fix.
//
// Free, offline, deterministic, and therefore runnable in CI, which is the point:
// a paid eval run cannot be a regression gate.
//
// Usage: node evals/scripts/latency-breakdown.ts
//        node evals/scripts/latency-breakdown.ts --json
//        node evals/scripts/latency-breakdown.ts --repeat 20

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSrcModule, REPO_ROOT } from "../harness/loadSrcModule.ts";
import {
  createCapturingFetch,
  installMemoryLocalStorage,
} from "../harness/fakeGlobals.ts";
import { loadAiProviders } from "../harness/providerConfig.ts";
import type { FetchAIResponseParams } from "../harness/runTask.ts";

interface AiModule {
  fetchAIResponse(params: FetchAIResponseParams): AsyncIterable<string>;
}

interface CommonModule {
  buildDynamicMessages(
    messagesTemplate: unknown[],
    history: unknown[],
    userMessage: string,
    imagesBase64?: string[]
  ): unknown[];
  deepVariableReplacer(node: unknown, variables: Record<string, string>): unknown;
}

/** Fixtures are the same captures the vision tasks grade, so the sizes are real. */
const FIXTURES = [
  { label: "no image", path: null },
  {
    label: "region 1440x900",
    path: "evals/fixtures/vision/vscode-web-adapters-2x.png",
  },
  {
    label: "full screen 2560x1600",
    path: "evals/fixtures/vision/vscode-web-fullscreen-2560x1600.png",
  },
] as const;

const parseArgs = (argv: string[]) => {
  const args = { json: false, repeat: 10 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") args.json = true;
    else if (argv[i] === "--repeat") {
      args.repeat = Number(argv[i + 1]);
      i++;
    }
  }
  return args;
};

const loadFixture = (path: string | null): string[] => {
  if (!path) return [];
  return [readFileSync(join(REPO_ROOT, path)).toString("base64")];
};

/** Median rather than mean: one GC pause should not become the headline. */
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const round = (n: number): number => Math.round(n * 100) / 100;

const main = async () => {
  const { json, repeat } = parseArgs(process.argv.slice(2));

  const { fetchAIResponse } = await loadSrcModule<AiModule>(
    "lib/functions/ai-response.function.ts"
  );
  const { buildDynamicMessages, deepVariableReplacer } =
    await loadSrcModule<CommonModule>("lib/functions/common.function.ts");

  const providers = await loadAiProviders();
  const provider = providers.find((p) => p.id === "openai");
  if (!provider) throw new Error("expected the shipped openai provider");
  const selectedProvider = {
    provider: "openai",
    variables: { api_key: "test-key", model: "gpt-4o-mini" },
  };

  // The same variable map fetchAIResponse builds, so the replacer walk below is
  // the real one and not a smaller stand-in.
  const variables = {
    API_KEY: "test-key",
    MODEL: "gpt-4o-mini",
    SYSTEM_PROMPT: "You are a helpful AI assistant.",
  };

  const rows = [];
  for (const fixture of FIXTURES) {
    const imagesBase64 = loadFixture(fixture.path);
    const payloadKb = imagesBase64.length
      ? Math.round(imagesBase64[0].length / 1024)
      : 0;

    const totals: number[] = [];
    const replacerTimes: number[] = [];
    const buildTimes: number[] = [];
    const stringifyTimes: number[] = [];

    for (let run = 0; run < repeat; run++) {
      installMemoryLocalStorage({
        response_settings: JSON.stringify({
          responseLength: "auto",
          language: "english",
          autoScroll: true,
        }),
      });

      // Total: everything fetchAIResponse does before the request leaves, plus
      // the streaming parse of a canned one-chunk response.
      const capturing = createCapturingFetch();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = capturing.fetch;
      const startedAt = performance.now();
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
        totals.push(performance.now() - startedAt);
      }

      // Attribution. These are the exported helpers fetchAIResponse calls, given
      // the same inputs, so each number is a share of the total above.
      const template = [
        { role: "system", content: "{{SYSTEM_PROMPT}}" },
        {
          role: "user",
          content: [
            { type: "text", text: "{{TEXT}}" },
            { type: "image_url", image_url: { url: "{{IMAGE}}" } },
          ],
        },
      ];

      const buildStart = performance.now();
      const messages = buildDynamicMessages(
        template,
        [],
        "what does this function do?",
        imagesBase64
      );
      buildTimes.push(performance.now() - buildStart);

      const body = { model: "{{MODEL}}", messages, stream: true };
      const replaceStart = performance.now();
      const replaced = deepVariableReplacer(body, variables);
      replacerTimes.push(performance.now() - replaceStart);

      const stringifyStart = performance.now();
      JSON.stringify(replaced);
      stringifyTimes.push(performance.now() - stringifyStart);
    }

    rows.push({
      case: fixture.label,
      payloadKb,
      totalMs: round(median(totals)),
      buildMessagesMs: round(median(buildTimes)),
      replacerMs: round(median(replacerTimes)),
      stringifyMs: round(median(stringifyTimes)),
    });
  }

  if (json) {
    console.log(JSON.stringify({ repeat, rows }, null, 2));
    return;
  }

  console.log(
    `\nClient-side assembly cost before the first byte leaves the process.\n` +
      `Median of ${repeat} runs, no network in the path.\n`
  );
  const header = [
    "case".padEnd(24),
    "base64".padStart(8),
    "total".padStart(9),
    "buildMsgs".padStart(11),
    "replacer".padStart(10),
    "stringify".padStart(11),
  ].join("");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const row of rows) {
    console.log(
      [
        row.case.padEnd(24),
        `${row.payloadKb}KB`.padStart(8),
        `${row.totalMs}ms`.padStart(9),
        `${row.buildMessagesMs}ms`.padStart(11),
        `${row.replacerMs}ms`.padStart(10),
        `${row.stringifyMs}ms`.padStart(11),
      ].join("")
    );
  }
  console.log("");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
