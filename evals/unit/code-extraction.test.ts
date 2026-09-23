// Unit tests for code extraction in AutoTypeButton.
// Verifies edge cases: malformed markdown, nested fences, variable names like assertion_count/assertive,
// multi-language snippets, and structured omni assessment blocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrcModule } from "../harness/loadSrcModule.ts";

interface AutoTypeModule {
  extractCodeToType(markdown: string): string;
}

const { extractCodeToType } = await loadSrcModule<AutoTypeModule>(
  "components/Markdown/auto-type-button.tsx"
);

test("preserves variables named assertion_count and words like assertive", () => {
  const markdown = [
    "```omni",
    "shape: code",
    "answer: count assertions",
    "confidence: high",
    "```",
    "",
    "```python",
    "def analyze_assertive_statements(text: str) -> dict:",
    "    assertion_count = 0",
    "    assertive = True",
    "    if 'must' in text:",
    "        assertion_count += 1",
    "    return {'count': assertion_count, 'assertive': assertive}",
    "```",
    "",
    "```python",
    "# Test runner block",
    "assert analyze_assertive_statements('must do') == {'count': 1, 'assertive': True}",
    "```",
  ].join("\n");

  const extracted = extractCodeToType(markdown);
  assert.ok(extracted.includes("assertion_count = 0"));
  assert.ok(extracted.includes("assertive = True"));
  assert.ok(!extracted.includes("shape: code"));
  assert.ok(!extracted.includes("# Test runner block"));
  assert.ok(!extracted.includes("assert analyze_assertive_statements"));
});

test("handles malformed unclosed code fences gracefully", () => {
  const unclosed = [
    "```python",
    "def solve(n: int) -> int:",
    "    return n * 2",
  ].join("\n");

  const extracted = extractCodeToType(unclosed);
  assert.equal(extracted, "def solve(n: int) -> int:\n    return n * 2");
});

test("handles CRLF line endings and code fence attributes/trailing spaces", () => {
  const crlfMarkdown =
    '```python filename="solution.py"  \r\ndef solve(x):\r\n    return x + 1\r\n```';
  const extracted = extractCodeToType(crlfMarkdown);
  assert.equal(extracted, "def solve(x):\n    return x + 1");
});

test("handles languages with special characters like c++, c#, and f#", () => {
  const cpp = [
    "```c++",
    "int solve(int a, int b) {",
    "    return a + b;",
    "}",
    "```",
  ].join("\n");

  const extracted = extractCodeToType(cpp);
  assert.equal(extracted, "int solve(int a, int b) {\n    return a + b;\n}");
});

test("handles nested code fences without premature closing", () => {
  const nested = [
    "````markdown",
    "Here is the example code:",
    "```python",
    "print('hello world')",
    "```",
    "End of example.",
    "````",
  ].join("\n");

  const extracted = extractCodeToType(nested);
  assert.ok(extracted.includes("```python\nprint('hello world')\n```"));
  assert.ok(extracted.includes("Here is the example code:"));
  assert.ok(extracted.includes("End of example."));
});

test("extracts and joins multi-language snippets", () => {
  const multi = [
    "```sql",
    "CREATE TABLE items (id INT PRIMARY KEY, val TEXT);",
    "```",
    "",
    "```python",
    "def get_item():",
    "    return 'item'",
    "```",
  ].join("\n");

  const extracted = extractCodeToType(multi);
  assert.equal(
    extracted,
    "CREATE TABLE items (id INT PRIMARY KEY, val TEXT);\n\ndef get_item():\n    return 'item'"
  );
});

test("handles structured contract blocks and strips omni block while keeping solution", () => {
  const response = [
    "```omni",
    "shape: code",
    "answer: twoSum hash table solution",
    "confidence: high",
    "```",
    "",
    "Here is the optimized solution:",
    "",
    "```python",
    "class Solution:",
    "    def twoSum(self, nums: list[int], target: int) -> list[int]:",
    "        lookup = {}",
    "        for i, num in enumerate(nums):",
    "            comp = target - num",
    "            if comp in lookup:",
    "                return [lookup[comp], i]",
    "            lookup[num] = i",
    "        return []",
    "```",
    "",
    "```python",
    "# Verification",
    "assert Solution().twoSum([2, 7, 11, 15], 9) == [0, 1]",
    "```",
  ].join("\n");

  const extracted = extractCodeToType(response);
  assert.ok(extracted.includes("class Solution:"));
  assert.ok(extracted.includes("lookup[num] = i"));
  assert.ok(!extracted.includes("```omni"));
  assert.ok(!extracted.includes("# Verification"));
});

test("keeps defensive assertions when solution is the only code block", () => {
  const singleBlock = [
    "```python",
    "def divide(a: int, b: int) -> float:",
    "    assert b != 0, 'divisor cannot be zero'",
    "    return a / b",
    "```",
  ].join("\n");

  const extracted = extractCodeToType(singleBlock);
  assert.ok(extracted.includes("def divide(a: int, b: int) -> float:"));
  assert.ok(extracted.includes("assert b != 0"));
});

test("returns empty string on empty or falsy input", () => {
  assert.equal(extractCodeToType(""), "");
});

test("falls back to clean body when no code blocks exist", () => {
  const prose = [
    "```omni",
    "shape: prose",
    "answer: Use binary search",
    "```",
    "Binary search operates in O(log N) time complexity.",
  ].join("\n");

  assert.equal(
    extractCodeToType(prose),
    "Binary search operates in O(log N) time complexity."
  );
});
