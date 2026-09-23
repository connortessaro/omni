/**
 * Edge-case verification script for extractCodeToType.
 * Run directly with: npx tsx scripts/test-extract-code.ts
 */
import assert from "node:assert/strict";
import { extractCodeToType } from "../src/components/Markdown/auto-type-button";

console.log("Starting edge-case verification for extractCodeToType...\n");

const tests = [
  {
    name: "Variables named 'assertion_count' or words like 'assertive' preserved",
    input: `\`\`\`omni
shape: code
answer: count assertions
confidence: high
\`\`\`

Here is the solution:

\`\`\`python
def count_assertive_statements(text: str) -> dict:
    assertion_count = 0
    assertive_score = 0.95
    assertive_terms = ["definitely", "certainly"]
    for term in assertive_terms:
        if term in text:
            assertion_count += 1
    return {"assertion_count": assertion_count, "assertive": assertion_count > 0}
\`\`\`

\`\`\`python
# Test harness
assert count_assertive_statements("definitely yes") == {"assertion_count": 1, "assertive": True}
\`\`\``,
    verify: (out: string) => {
      assert.ok(out.includes("assertion_count = 0"), "Must preserve assertion_count variable");
      assert.ok(out.includes("assertive_score = 0.95"), "Must preserve assertive variable");
      assert.ok(!out.includes("```omni"), "Must strip omni contract");
      assert.ok(!out.includes("# Test harness"), "Must strip test harness");
      assert.ok(!out.includes("assert count_assertive_statements"), "Must strip test assertion");
    },
  },
  {
    name: "Malformed markdown: unclosed code fence",
    input: `\`\`\`python
def solve(n: int) -> int:
    return n * 2`,
    verify: (out: string) => {
      assert.equal(out, "def solve(n: int) -> int:\n    return n * 2");
    },
  },
  {
    name: "CRLF line endings and info strings/trailing spaces",
    input: "```python filename=\"solution.py\"  \r\ndef solve(x):\r\n    return x + 1\r\n```",
    verify: (out: string) => {
      assert.equal(out, "def solve(x):\n    return x + 1");
    },
  },
  {
    name: "Languages with special chars (C++, C#, F#)",
    input: `\`\`\`c++
int solve(int a, int b) {
    return a + b;
}
\`\`\``,
    verify: (out: string) => {
      assert.equal(out, "int solve(int a, int b) {\n    return a + b;\n}");
    },
  },
  {
    name: "Nested markdown code fences (4 backticks enclosing 3 backticks)",
    input: `\`\`\`\`markdown
Here is the example code:
\`\`\`python
print('nested')
\`\`\`
Done.
\`\`\`\``,
    verify: (out: string) => {
      assert.ok(out.includes("```python\nprint('nested')\n```"));
      assert.ok(out.includes("Here is the example code:"));
    },
  },
  {
    name: "Multi-language code snippets",
    input: `\`\`\`sql
CREATE TABLE users (id SERIAL PRIMARY KEY);
\`\`\`

\`\`\`python
def query():
    return "ok"
\`\`\``,
    verify: (out: string) => {
      assert.equal(
        out,
        "CREATE TABLE users (id SERIAL PRIMARY KEY);\n\ndef query():\n    return \"ok\""
      );
    },
  },
  {
    name: "Structured contract with pure solution and test runner",
    input: `\`\`\`omni
shape: code
answer: twoSum
confidence: high
\`\`\`

\`\`\`python
class Solution:
    def twoSum(self, nums: list[int], target: int) -> list[int]:
        seen = {}
        for i, x in enumerate(nums):
            if target - x in seen:
                return [seen[target - x], i]
            seen[x] = i
        return []
\`\`\`

\`\`\`python
assert Solution().twoSum([2, 7, 11, 15], 9) == [0, 1]
\`\`\``,
    verify: (out: string) => {
      assert.ok(out.includes("class Solution:"));
      assert.ok(out.includes("seen[x] = i"));
      assert.ok(!out.includes("```omni"));
      assert.ok(!out.includes("assert Solution()"));
    },
  },
  {
    name: "Single code block with defensive assert is preserved",
    input: `\`\`\`python
def safe_divide(a: int, b: int) -> float:
    assert b != 0, "division by zero"
    return a / b
\`\`\``,
    verify: (out: string) => {
      assert.ok(out.includes("def safe_divide"));
      assert.ok(out.includes("assert b != 0"));
    },
  },
];

let passed = 0;
for (const testCase of tests) {
  try {
    const result = extractCodeToType(testCase.input);
    testCase.verify(result);
    console.log(`✅ PASS: ${testCase.name}`);
    passed++;
  } catch (error: any) {
    console.error(`❌ FAIL: ${testCase.name}`);
    console.error(error.message);
    process.exitCode = 1;
  }
}

console.log(`\nCompleted: ${passed}/${tests.length} tests passed.`);
