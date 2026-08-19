export interface SubstringGradeResult {
  pass: boolean;
  matched: string[];
  missing: string[];
}

export function gradeSubstring(
  responseText: string,
  expectedAll: string[],
  caseSensitive = false
): SubstringGradeResult {
  const haystack = caseSensitive ? responseText : responseText.toLowerCase();
  const matched: string[] = [];
  const missing: string[] = [];
  for (const needle of expectedAll) {
    const target = caseSensitive ? needle : needle.toLowerCase();
    if (haystack.includes(target)) {
      matched.push(needle);
    } else {
      missing.push(needle);
    }
  }
  return { pass: missing.length === 0, matched, missing };
}
