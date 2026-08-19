import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { CodeExecCase } from "../types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.join(__dirname, "..", ".tmp");
const EXEC_TIMEOUT_MS = 5000;

export interface CaseResult {
  description: string;
  pass: boolean;
  actual?: unknown;
  expected: unknown;
  error?: string;
}

export interface CodeExecGradeResult {
  pass: boolean;
  extractionError?: string;
  cases: CaseResult[];
}

const CODE_FENCE_RE = /```[a-zA-Z]*\n([\s\S]*?)```/g;

export function extractCode(responseText: string): string | null {
  const blocks: string[] = [];
  for (const match of responseText.matchAll(CODE_FENCE_RE)) {
    if (match[1].trim()) blocks.push(match[1]);
  }
  if (blocks.length === 0) return null;
  return blocks.join("\n\n");
}

function buildHarnessScript(code: string, cases: CodeExecCase[]): string {
  const fnNames = new Set<string>();
  for (const c of cases) for (const call of c.calls) fnNames.add(call.fn);

  const fnTableEntries = [...fnNames]
    .map((name) => `  ${JSON.stringify(name)}: (typeof ${name} !== "undefined" ? ${name} : undefined)`)
    .join(",\n");

  return `
${code}

const __fnTable = {
${fnTableEntries}
};

async function __main() {
  const __cases = ${JSON.stringify(cases)};
  const __results = [];
  for (const __case of __cases) {
    const __callResults = [];
    for (const __call of __case.calls) {
      const __fn = __fnTable[__call.fn];
      try {
        if (typeof __fn !== "function") {
          throw new Error("function \\"" + __call.fn + "\\" is not defined by the submitted code");
        }
        const __r = await __fn(...__call.args);
        __callResults.push(__r === undefined ? null : __r);
      } catch (__e) {
        __callResults.push({ __threw: String((__e && __e.message) || __e) });
      }
    }
    __results.push(__callResults);
  }
  process.stdout.write(JSON.stringify(__results));
}

__main();
`;
}

function runHarnessScript(script: string): unknown[] {
  mkdirSync(TMP_DIR, { recursive: true });
  const scriptPath = path.join(TMP_DIR, `${randomUUID()}.cjs`);
  writeFileSync(scriptPath, script, "utf8");
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], {
      timeout: EXEC_TIMEOUT_MS,
      encoding: "utf8",
    });
    return JSON.parse(stdout) as unknown[];
  } finally {
    rmSync(scriptPath, { force: true });
  }
}

export async function gradeCodeExec(
  responseText: string,
  cases: CodeExecCase[]
): Promise<CodeExecGradeResult> {
  const code = extractCode(responseText);
  if (code === null) {
    return {
      pass: false,
      extractionError: "no fenced code block found in response",
      cases: cases.map((c) => ({
        description: c.description,
        pass: false,
        expected: c.expected,
        error: "no code to run",
      })),
    };
  }

  const script = buildHarnessScript(code, cases);

  let rawResults: unknown[];
  try {
    rawResults = runHarnessScript(script);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      pass: false,
      extractionError: `submitted code failed to execute: ${message}`,
      cases: cases.map((c) => ({
        description: c.description,
        pass: false,
        expected: c.expected,
        error: message,
      })),
    };
  }

  const caseResults: CaseResult[] = cases.map((c, i) => {
    const actual = rawResults[i];
    try {
      assert.deepStrictEqual(actual, c.expected);
      return { description: c.description, pass: true, actual, expected: c.expected };
    } catch {
      return { description: c.description, pass: false, actual, expected: c.expected };
    }
  });

  return {
    pass: caseResults.every((c) => c.pass),
    cases: caseResults,
  };
}
