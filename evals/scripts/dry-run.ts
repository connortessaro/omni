import { loadSrcModule } from "../harness/loadSrcModule.ts";
import { loadAiProviders, type RawProvider, type SelectedProvider } from "../harness/providerConfig.ts";
import { createCapturingFetch, installMemoryLocalStorage } from "../harness/fakeGlobals.ts";
import { runTaskAgainstOmni, type OmniAiResponseModule } from "../harness/runTask.ts";
import { ALL_TASKS } from "../tasks/index.ts";
import type { Task } from "../types.ts";

const DEFAULT_SAMPLE_TASK_IDS = [
  "coding-two-sum",
  "debug-shared-default-array",
  "reason-discount-then-tax",
  "long-context-source-function-return",
];

function parseArgs(argv: string[]): { taskIds: string[] | null; provider: string } {
  let taskIds: string[] | null = null;
  let provider = "openai";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--all") taskIds = ALL_TASKS.map((t) => t.id);
    if (argv[i] === "--task" && argv[i + 1]) taskIds = argv[i + 1].split(",");
    if (argv[i] === "--provider" && argv[i + 1]) provider = argv[i + 1];
  }
  return { taskIds, provider };
}

function printRequest(label: string, capture: { url: string; headers: Record<string, string>; bodyJson: unknown }) {
  console.log(`\n--- ${label} ---`);
  console.log("URL:", capture.url);
  console.log("Headers:", JSON.stringify(capture.headers, null, 2));
  console.log("Body:", JSON.stringify(capture.bodyJson, null, 2));
}

async function runOne(
  task: Task,
  omni: OmniAiResponseModule,
  provider: RawProvider,
  selectedProvider: SelectedProvider
) {
  const canned = createCapturingFetch({
    sseChunks: [
      'data: {"choices":[{"delta":{"content":"(dry-run canned response, no network call was made) "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"42"}}]}\n\n',
      "data: [DONE]\n\n",
    ],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = canned.fetch;
  try {
    const result = await runTaskAgainstOmni(task, omni, provider, selectedProvider, 5000);
    console.log(`\n=== ${task.id} (${task.category}) ===`);
    if (canned.calls[0]) printRequest("request Omni would send", canned.calls[0]);
    console.log("\nReconstructed streamed text (from the canned response):", JSON.stringify(result.responseText));
    if (result.errorText) console.log("Error surfaced by fetchAIResponse:", result.errorText);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function demonstrateSystemPromptStacking(
  task: Task,
  omni: OmniAiResponseModule,
  provider: RawProvider,
  selectedProvider: SelectedProvider
) {
  console.log("\n\n### buildEnhancedSystemPrompt proof: same task, two response-length settings ###");
  for (const responseLength of ["short", "medium"] as const) {
    installMemoryLocalStorage({
      response_settings: JSON.stringify({ responseLength, language: "english", autoScroll: true }),
    });
    const canned = createCapturingFetch();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = canned.fetch;
    try {
      await runTaskAgainstOmni(task, omni, provider, selectedProvider, 5000);
      const body = canned.calls[0]?.bodyJson as { messages?: Array<{ role: string; content: string }> } | undefined;
      const systemMessage = body?.messages?.find((m) => m.role === "system");
      console.log(`\n[responseLength=${responseLength}] system prompt sent to the provider:`);
      console.log(systemMessage?.content ?? "(none found)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
}

async function main() {
  const { taskIds, provider: providerId } = parseArgs(process.argv.slice(2));
  const selectedIds = taskIds ?? DEFAULT_SAMPLE_TASK_IDS;

  console.log("Loading fetchAIResponse from src/lib/functions/ai-response.function.ts (real production code, unmodified)...");
  const omni = await loadSrcModule<OmniAiResponseModule>("lib/functions/ai-response.function.ts");
  const providers = await loadAiProviders();
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) {
    console.error(`Unknown provider "${providerId}". Known: ${providers.map((p) => p.id).join(", ")}`);
    process.exit(1);
  }

  const selectedProvider: SelectedProvider = {
    provider: provider.id,
    variables: { api_key: "sk-eval-dry-run-fake-key", model: "gpt-4o-mini" },
  };

  installMemoryLocalStorage();

  const tasksToRun = ALL_TASKS.filter((t) => selectedIds.includes(t.id));
  if (tasksToRun.length === 0) {
    console.error(`No tasks matched: ${selectedIds.join(", ")}`);
    process.exit(1);
  }

  for (const task of tasksToRun) {
    if (task.grader.type === "manual") {
      console.log(`\n=== ${task.id} (${task.category}) === skipped: manual grader, see grader.gradingPath`);
      continue;
    }
    await runOne(task, omni, provider, selectedProvider);
  }

  const reasoningSample = ALL_TASKS.find((t) => t.id === "reason-discount-then-tax");
  if (reasoningSample) {
    await demonstrateSystemPromptStacking(reasoningSample, omni, provider, selectedProvider);
  }

  console.log("\n\nDry run complete. No network calls were made; every request above was captured and answered locally.");
}

main().catch((error) => {
  console.error("Dry run failed:", error);
  process.exit(1);
});
