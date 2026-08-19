import type { CodeExecCase } from "../types.ts";
import { gradeCodeExec, type CodeExecGradeResult } from "./codeExec.ts";

export interface DebugFixGradeResult {
  pass: boolean;
  testsPass: boolean;
  rootCauseIdentified: boolean;
  matchedKeyword?: string;
  codeExec: CodeExecGradeResult;
}

const describeEntry = (entry: string | string[]): string =>
  Array.isArray(entry) ? entry.join(" + ") : entry;

/**
 * A string entry must appear as a substring. An array entry requires every term
 * to appear somewhere in the response, so a concept can be matched without
 * demanding one exact phrasing. Literal phrase lists produced false negatives:
 * a response explaining that sort() "sorts elements as strings by default"
 * is correct but matches neither "string sort" nor "default sort".
 */
const entryMatches = (entry: string | string[], lowered: string): boolean =>
  Array.isArray(entry)
    ? entry.every((term) => lowered.includes(term.toLowerCase()))
    : lowered.includes(entry.toLowerCase());

export async function gradeDebugFix(
  responseText: string,
  cases: CodeExecCase[],
  rootCauseKeywords: (string | string[])[]
): Promise<DebugFixGradeResult> {
  const codeExec = await gradeCodeExec(responseText, cases);
  const lowered = responseText.toLowerCase();
  const matched = rootCauseKeywords.find((entry) => entryMatches(entry, lowered));
  const matchedKeyword = matched === undefined ? undefined : describeEntry(matched);

  return {
    pass: codeExec.pass && matchedKeyword !== undefined,
    testsPass: codeExec.pass,
    rootCauseIdentified: matchedKeyword !== undefined,
    matchedKeyword,
    codeExec,
  };
}
