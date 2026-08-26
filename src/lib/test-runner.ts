/**
 * Turns an assessment answer into something runnable, and its output into a verdict.
 *
 * The panel already shows the answer first. This answers the next question, which on a
 * timed assessment is the only one that matters: does it actually pass? The answer's own
 * code fences are the files, the test-looking one is the entry point, and the Rust
 * `run_code` command does the running.
 */

import { invoke } from "@tauri-apps/api/core";
import { CodeBlockRef, collectCodeBlocks } from "./assessment";

/** Languages with an interpreter on the Rust side. Kept in step with `interpreter_for`. */
const RUNNABLE: Record<string, { language: RunLanguage; extension: string }> = {
  python: { language: "python", extension: "py" },
  python3: { language: "python", extension: "py" },
  py: { language: "python", extension: "py" },
  javascript: { language: "javascript", extension: "js" },
  js: { language: "javascript", extension: "js" },
  node: { language: "javascript", extension: "js" },
  typescript: { language: "typescript", extension: "ts" },
  ts: { language: "typescript", extension: "ts" },
};

export type RunLanguage = "python" | "javascript" | "typescript";

export interface RunFile {
  path: string;
  content: string;
}

export interface RunPlan {
  language: RunLanguage;
  files: RunFile[];
  /** The file handed to the interpreter. */
  entry: string;
}

export interface RunResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  truncated: boolean;
  duration_ms: number;
  command: string;
}

export type RunStatus = "passed" | "failed" | "timeout";

export interface RunSummary {
  status: RunStatus;
  /** One line for the verdict rail: "12 passed", "3 of 12 failed", "Timed out". */
  headline: string;
  /** The part worth reading when it failed: the assertion, the traceback tail. */
  detail: string;
  passed: number | null;
  failed: number | null;
  durationMs: number;
}

/** A path that reads like the test file rather than the solution. */
const TEST_PATH = /(^|\/)tests?[_/-]|[_.-]tests?\.[a-z]+$|(^|\/)test[_.-]/i;

/** Source that is doing the checking, whatever it is called. */
const TEST_BODY =
  /\b(assert|unittest|pytest|describe\s*\(|it\s*\(|test\s*\(|console\.assert)\b/;

const defaultPath = (block: CodeBlockRef, extension: string, index: number): string =>
  block.path ?? (index === 0 ? `solution.${extension}` : `check_${index}.${extension}`);

/**
 * Returns null when there is nothing worth running: no fenced code, or none of it in a
 * language with a runner. The button is hidden in that case rather than failing on click.
 */
export const buildRunPlan = (body: string): RunPlan | null => {
  const blocks = collectCodeBlocks(body).filter((block) => block.code.trim().length > 0);
  if (blocks.length === 0) return null;

  // One language per run: the interpreter takes a single entry file, and an answer that
  // mixes Python with SQL has one runnable half at most.
  const runnable = blocks
    .map((block) => ({ block, match: RUNNABLE[block.language.toLowerCase()] }))
    .filter((entry): entry is { block: CodeBlockRef; match: (typeof RUNNABLE)[string] } =>
      Boolean(entry.match)
    );
  if (runnable.length === 0) return null;

  const { language, extension } = runnable[0].match;
  const sameLanguage = runnable.filter((entry) => entry.match.language === language);

  const files = sameLanguage.map((entry, index) => ({
    path: defaultPath(entry.block, extension, index),
    content: entry.block.code,
  }));

  // Deduplicate: two blocks labelled with the same path are the model showing a file
  // twice, and the later one is the finished version.
  const byPath = new Map<string, RunFile>();
  for (const file of files) byPath.set(file.path, file);
  const deduped = [...byPath.values()];

  // The entry is whichever file does the checking. Falling back to the last file rather
  // than the first matters: an answer that shows the solution and then exercises it puts
  // the interesting half at the bottom.
  const entry =
    deduped.find((file) => TEST_PATH.test(file.path))?.path ??
    deduped.find((file) => TEST_BODY.test(file.content))?.path ??
    deduped[deduped.length - 1].path;

  return { language, files: deduped, entry };
};

const firstMatch = (text: string, pattern: RegExp): number | null => {
  const found = pattern.exec(text);
  return found ? Number(found[1]) : null;
};

/**
 * Pulls counts out of whatever runner the answer happened to use. Nothing here is
 * required: an answer that just asserts and exits still reports pass or fail from its
 * exit code, which is the case that has to keep working.
 */
const readCounts = (output: string): { passed: number | null; failed: number | null } => {
  // pytest: "3 passed, 1 failed in 0.12s"
  const pytestPassed = firstMatch(output, /(\d+) passed/);
  const pytestFailed = firstMatch(output, /(\d+) failed/);
  if (pytestPassed !== null || pytestFailed !== null) {
    return { passed: pytestPassed, failed: pytestFailed };
  }

  // node:test: "# pass 5" / "# fail 1"
  const nodePassed = firstMatch(output, /^# pass (\d+)$/m);
  const nodeFailed = firstMatch(output, /^# fail (\d+)$/m);
  if (nodePassed !== null || nodeFailed !== null) {
    return { passed: nodePassed, failed: nodeFailed };
  }

  // unittest: "Ran 5 tests in 0.001s" then "OK" or "FAILED (failures=2)"
  const ran = firstMatch(output, /^Ran (\d+) tests?/m);
  if (ran !== null) {
    const failures = firstMatch(output, /failures=(\d+)/) ?? 0;
    const errors = firstMatch(output, /errors=(\d+)/) ?? 0;
    const failed = failures + errors;
    return { passed: ran - failed, failed };
  }

  return { passed: null, failed: null };
};

/** The line worth showing: the assertion that blew up, not the frames above it. */
const failureDetail = (result: RunResult): string => {
  const stderr = result.stderr.trim();
  if (stderr) {
    const lines = stderr.split("\n").filter((line) => line.trim().length > 0);
    // A Python traceback ends with the exception; everything above it is the path there.
    const exception = [...lines]
      .reverse()
      .find((line) => /^[A-Za-z_.]*(Error|Exception|Failure)\b/.test(line.trim()));
    return (exception ?? lines[lines.length - 1] ?? stderr).trim();
  }

  const stdout = result.stdout.trim();
  if (!stdout) return "The run produced no output.";
  return stdout.split("\n").slice(-1)[0].trim();
};

export const summarizeRun = (result: RunResult): RunSummary => {
  const combined = `${result.stdout}\n${result.stderr}`;
  const { passed, failed } = readCounts(combined);

  if (result.timed_out) {
    return {
      status: "timeout",
      headline: `Timed out after ${Math.round(result.duration_ms / 1000)}s`,
      detail:
        "The run was stopped at the deadline. An infinite loop or a wait on input will do this.",
      passed,
      failed,
      durationMs: result.duration_ms,
    };
  }

  const ok = result.exit_code === 0 && (failed === null || failed === 0);

  if (ok) {
    return {
      status: "passed",
      headline:
        passed !== null && passed > 0
          ? `${passed} passed`
          : "Ran clean",
      detail: result.stdout.trim() || "No output.",
      passed,
      failed,
      durationMs: result.duration_ms,
    };
  }

  const total = (passed ?? 0) + (failed ?? 0);
  // No counts and a non-zero exit is still a failure the reader must not transcribe,
  // whether it came from an assertion, an import error or a syntax error. "Exited 1"
  // made the reader work out which; the exit code stays, in parentheses, for the
  // crash cases where it is the only thing that distinguishes them.
  return {
    status: "failed",
    headline:
      failed !== null && failed > 0
        ? total > 0
          ? `${failed} of ${total} failed`
          : `${failed} failed`
        : `Failed (exit ${result.exit_code})`,
    detail: failureDetail(result),
    passed,
    failed,
    durationMs: result.duration_ms,
  };
};

/** Runs the plan and reduces it to something the panel can show in one line. */
export const runPlan = async (
  plan: RunPlan,
  timeoutMs?: number
): Promise<RunSummary> => {
  const result = await invoke<RunResult>("run_code", {
    language: plan.language,
    files: plan.files,
    entry: plan.entry,
    timeoutMs: timeoutMs ?? null,
  });
  return summarizeRun(result);
};
