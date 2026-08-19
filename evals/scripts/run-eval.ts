import { loadSrcModule } from "../harness/loadSrcModule.ts";
import {
  resolveProviderFromEnv,
  MissingEvalCredentialsError,
} from "../harness/providerConfig.ts";
import { installMemoryLocalStorage } from "../harness/fakeGlobals.ts";
import { runTaskAgainstOmni, type OmniAiResponseModule } from "../harness/runTask.ts";
import { gradeTask } from "../graders/index.ts";
import { ALL_TASKS } from "../tasks/index.ts";
import type { Task } from "../types.ts";

const PASS_BAR = 0.7;

function parseArgs(argv: string[]): { category: string | null; taskIds: string[] | null } {
  let category: string | null = null;
  let taskIds: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--category" && argv[i + 1]) category = argv[i + 1];
    if (argv[i] === "--task" && argv[i + 1]) taskIds = argv[i + 1].split(",");
  }
  return { category, taskIds };
}

async function main() {
  const { category, taskIds } = parseArgs(process.argv.slice(2));

  let resolved;
  try {
    resolved = await resolveProviderFromEnv();
  } catch (error) {
    if (error instanceof MissingEvalCredentialsError) {
      console.error(`\nCannot run live evals: ${error.message}\n`);
      console.error("Set OMNI_EVAL_PROVIDER and OMNI_EVAL_API_KEY (see evals/README.md) and re-run.");
      console.error("No requests were sent and no results were produced.\n");
      process.exit(1);
    }
    throw error;
  }

  const { provider, selectedProvider } = resolved;

  installMemoryLocalStorage({
    response_settings: JSON.stringify({ responseLength: "auto", language: "english", autoScroll: true }),
  });

  console.log(`Loading fetchAIResponse from src/lib/functions/ai-response.function.ts (provider=${provider.id})...`);
  const omni = await loadSrcModule<OmniAiResponseModule>("lib/functions/ai-response.function.ts");

  let tasks: Task[] = ALL_TASKS;
  if (taskIds) tasks = tasks.filter((t) => taskIds.includes(t.id));
  if (category) tasks = tasks.filter((t) => t.category === category);

  if (tasks.length === 0) {
    console.error("No tasks matched the given --category/--task filters.");
    process.exit(1);
  }

  let automatedCount = 0;
  let automatedPassCount = 0;
  let skippedManual = 0;

  for (const task of tasks) {
    if (task.grader.type === "manual") {
      skippedManual++;
      console.log(`SKIP  ${task.id.padEnd(38)} manual grader — ${task.grader.gradingPath.slice(0, 70)}...`);
      continue;
    }

    const runResult = await runTaskAgainstOmni(task, omni, provider, selectedProvider);
    const textForGrading = runResult.errorText ?? runResult.responseText;
    const outcome = await gradeTask(task, textForGrading);

    automatedCount++;
    if (outcome.pass) automatedPassCount++;

    const status = outcome.pass ? "PASS" : "FAIL";
    console.log(
      `${status}  ${task.id.padEnd(38)} ${task.category.padEnd(13)} ${runResult.durationMs}ms  ${outcome.summary}`
    );
    if (runResult.errorText) {
      console.log(`      -> fetchAIResponse error: ${runResult.errorText}`);
    }
  }

  const passRate = automatedCount === 0 ? 0 : automatedPassCount / automatedCount;
  console.log("\n--- summary ---");
  console.log(`Automated tasks graded: ${automatedCount}`);
  console.log(`Passed: ${automatedPassCount} (${(passRate * 100).toFixed(1)}%)`);
  console.log(`Skipped (manual grader): ${skippedManual}`);
  console.log(`Pass bar: ${(PASS_BAR * 100).toFixed(0)}%`);
  console.log(passRate >= PASS_BAR ? "RESULT: above pass bar" : "RESULT: below pass bar");

  process.exitCode = passRate >= PASS_BAR ? 0 : 1;
}

main().catch((error) => {
  console.error("run-eval failed:", error);
  process.exit(1);
});
