import type { Task } from "../types.ts";
import { gradeCodeExec } from "./codeExec.ts";
import { gradeDebugFix } from "./debugFix.ts";
import { gradeNumeric } from "./numeric.ts";
import { gradeSubstring } from "./substring.ts";

export interface GradeOutcome {
  pass: boolean;
  automated: boolean;
  summary: string;
  details: unknown;
}

export async function gradeTask(task: Task, responseText: string): Promise<GradeOutcome> {
  switch (task.grader.type) {
    case "code-exec": {
      const result = await gradeCodeExec(responseText, task.grader.cases);
      const passedCount = result.cases.filter((c) => c.pass).length;
      return {
        pass: result.pass,
        automated: true,
        summary: `${passedCount}/${result.cases.length} test cases passed${
          result.extractionError ? ` (${result.extractionError})` : ""
        }`,
        details: result,
      };
    }
    case "debug-fix": {
      const result = await gradeDebugFix(
        responseText,
        task.grader.cases,
        task.grader.rootCauseKeywords
      );
      const passedCount = result.codeExec.cases.filter((c) => c.pass).length;
      return {
        pass: result.pass,
        automated: true,
        summary: `${passedCount}/${result.codeExec.cases.length} tests passed, root cause ${
          result.rootCauseIdentified ? `identified ("${result.matchedKeyword}")` : "NOT identified"
        }`,
        details: result,
      };
    }
    case "numeric": {
      const result = gradeNumeric(responseText, task.grader.expected, task.grader.tolerance);
      return {
        pass: result.pass,
        automated: true,
        summary:
          result.extracted === null
            ? (result.error ?? "no numeric answer found")
            : `extracted ${result.extracted}, expected ${result.expected} (+/- ${result.tolerance})`,
        details: result,
      };
    }
    case "substring": {
      const result = gradeSubstring(
        responseText,
        task.grader.expectedAll,
        task.grader.caseSensitive
      );
      return {
        pass: result.pass,
        automated: true,
        summary:
          result.missing.length === 0
            ? "all expected facts present"
            : `missing: ${result.missing.join(", ")}`,
        details: result,
      };
    }
    case "manual": {
      return {
        pass: false,
        automated: false,
        summary: "not automated — see grader.gradingPath",
        details: { gradingPath: task.grader.gradingPath },
      };
    }
  }
}
