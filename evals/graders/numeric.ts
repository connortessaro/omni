const FINAL_ANSWER_RE = /final answer\s*:?\s*\$?(-?[\d,]+(?:\.\d+)?)/gi;

export interface NumericGradeResult {
  pass: boolean;
  extracted: number | null;
  expected: number;
  tolerance: number;
  error?: string;
}

export function extractFinalAnswer(responseText: string): number | null {
  let lastMatch: RegExpExecArray | null = null;
  for (const match of responseText.matchAll(FINAL_ANSWER_RE)) {
    lastMatch = match;
  }
  if (!lastMatch) return null;
  const cleaned = lastMatch[1].replace(/,/g, "");
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

export function gradeNumeric(
  responseText: string,
  expected: number,
  tolerance: number
): NumericGradeResult {
  const extracted = extractFinalAnswer(responseText);
  if (extracted === null) {
    return {
      pass: false,
      extracted: null,
      expected,
      tolerance,
      error: 'no "Final answer: <number>" line found in response',
    };
  }
  const pass = Math.abs(extracted - expected) <= tolerance;
  return { pass, extracted, expected, tolerance };
}
