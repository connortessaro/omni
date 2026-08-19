import type { CodeExecCase } from "../types.ts";
import { gradeCodeExec, type CodeExecGradeResult } from "./codeExec.ts";

export interface DebugFixGradeResult {
  pass: boolean;
  testsPass: boolean;
  rootCauseIdentified: boolean;
  matchedKeyword?: string;
  codeExec: CodeExecGradeResult;
}

export async function gradeDebugFix(
  responseText: string,
  cases: CodeExecCase[],
  rootCauseKeywords: string[]
): Promise<DebugFixGradeResult> {
  const codeExec = await gradeCodeExec(responseText, cases);
  const lowered = responseText.toLowerCase();
  const matchedKeyword = rootCauseKeywords.find((keyword) =>
    lowered.includes(keyword.toLowerCase())
  );

  return {
    pass: codeExec.pass && matchedKeyword !== undefined,
    testsPass: codeExec.pass,
    rootCauseIdentified: matchedKeyword !== undefined,
    matchedKeyword,
    codeExec,
  };
}
