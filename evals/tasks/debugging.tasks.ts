import type { Task } from "../types.ts";

const FIX_INSTRUCTION =
  "First explain the root cause in one or two sentences. Then give the corrected function in a single JavaScript code block (only the fixed function, no example usage).";

export const debuggingTasks: Task[] = [
  {
    id: "debug-off-by-one-range-sum",
    category: "debugging",
    title: "Off-by-one range sum",
    prompt:
      `This function is documented to sum the half-open range [start, end) of ` +
      `\`arr\` — the same convention as \`Array.prototype.slice(start, end)\`:\n\n` +
      "```javascript\n" +
      "function sumRange(arr, start, end) {\n" +
      "  let sum = 0;\n" +
      "  for (let i = start; i <= end; i++) {\n" +
      "    sum += arr[i];\n" +
      "  }\n" +
      "  return sum;\n" +
      "}\n" +
      "```\n\n" +
      "Symptom: `sumRange([10, 20, 30, 40, 50], 0, 5)` returns `NaN` instead of `150`, " +
      "and `sumRange([10, 20, 30, 40, 50], 1, 3)` returns `90` instead of the expected `50`. " +
      FIX_INSTRUCTION,
    grader: {
      type: "debug-fix",
      language: "javascript",
      rootCauseKeywords: [
        "off-by-one",
        "off by one",
        "boundary",
        "<= end",
        "half-open",
        "exclusive",
        ["loop", "last element"],
      ],
      cases: [
        {
          description: "full range",
          calls: [{ fn: "sumRange", args: [[10, 20, 30, 40, 50], 0, 5] }],
          expected: [150],
        },
        {
          description: "middle range",
          calls: [{ fn: "sumRange", args: [[10, 20, 30, 40, 50], 1, 3] }],
          expected: [50],
        },
        { description: "empty range", calls: [{ fn: "sumRange", args: [[1, 2, 3], 0, 0] }], expected: [0] },
      ],
    },
  },
  {
    id: "debug-shared-default-array",
    category: "debugging",
    title: "Shared default array reference",
    prompt:
      `Two back-to-back calls to this function are producing tags that bleed into each ` +
      `other:\n\n` +
      "```javascript\n" +
      'const DEFAULT_TAGS = ["new"];\n\n' +
      "function createProduct(name, tags = DEFAULT_TAGS) {\n" +
      "  tags.push(name.toLowerCase());\n" +
      "  return { name, tags };\n" +
      "}\n" +
      "```\n\n" +
      'Symptom: `const p1 = createProduct("Widget"); const p2 = createProduct("Gadget");` ' +
      'leaves `p1.tags` as `["new", "widget", "gadget"]` — the second call also mutated the ' +
      "first product's tags, even though p1 was never touched again. " +
      FIX_INSTRUCTION,
    grader: {
      type: "debug-fix",
      language: "javascript",
      rootCauseKeywords: ["shared", "same array", "same reference", "default parameter", "mutat", "reference"],
      cases: [
        {
          description: "two sequential calls stay isolated",
          calls: [
            { fn: "createProduct", args: ["Widget"] },
            { fn: "createProduct", args: ["Gadget"] },
          ],
          expected: [
            { name: "Widget", tags: ["new", "widget"] },
            { name: "Gadget", tags: ["new", "gadget"] },
          ],
        },
      ],
    },
  },
  {
    id: "debug-missing-await",
    category: "debugging",
    title: "Missing await on an async lookup",
    prompt:
      `This function is supposed to build a "Name (role)" label:\n\n` +
      "```javascript\n" +
      "function getUserLabel(userId, users) {\n" +
      "  const user = users.find((u) => u.id === userId);\n" +
      "  const rolePromise = Promise.resolve(user ? user.role : \"guest\");\n" +
      "  return `${user ? user.name : \"Unknown\"} (${rolePromise})`;\n" +
      "}\n" +
      "```\n\n" +
      'Symptom: `getUserLabel(1, users)` returns `"Alice ([object Promise])"` instead of ' +
      '"Alice (admin)". ' +
      FIX_INSTRUCTION,
    grader: {
      type: "debug-fix",
      language: "javascript",
      rootCauseKeywords: ["await", "async", "promise", "unresolved", ["pending", "return"]],
      cases: [
        {
          description: "known user",
          calls: [
            {
              fn: "getUserLabel",
              args: [
                1,
                [
                  { id: 1, name: "Alice", role: "admin" },
                  { id: 2, name: "Bob", role: "editor" },
                ],
              ],
            },
          ],
          expected: ["Alice (admin)"],
        },
        {
          description: "second known user",
          calls: [
            {
              fn: "getUserLabel",
              args: [
                2,
                [
                  { id: 1, name: "Alice", role: "admin" },
                  { id: 2, name: "Bob", role: "editor" },
                ],
              ],
            },
          ],
          expected: ["Bob (editor)"],
        },
        {
          description: "unknown user falls back to guest",
          calls: [{ fn: "getUserLabel", args: [3, [{ id: 1, name: "Alice", role: "admin" }]] }],
          expected: ["Unknown (guest)"],
        },
      ],
    },
  },
  {
    id: "debug-floating-point-equality",
    category: "debugging",
    title: "Floating point equality check",
    prompt:
      `This function checks whether a list of prices adds up to an exact total:\n\n` +
      "```javascript\n" +
      "function isExactTotal(prices, expectedTotal) {\n" +
      "  const total = prices.reduce((sum, p) => sum + p, 0);\n" +
      "  return total === expectedTotal;\n" +
      "}\n" +
      "```\n\n" +
      "Symptom: `isExactTotal([0.1, 0.2], 0.3)` returns `false`, even though 0.1 + 0.2 " +
      '"should" equal 0.3. ' +
      FIX_INSTRUCTION,
    grader: {
      type: "debug-fix",
      language: "javascript",
      rootCauseKeywords: ["floating point", "floating-point", "precision", "epsilon", "rounding", "ieee"],
      cases: [
        { description: "classic rounding case", calls: [{ fn: "isExactTotal", args: [[0.1, 0.2], 0.3] }], expected: [true] },
        { description: "genuinely different total", calls: [{ fn: "isExactTotal", args: [[1, 2, 3], 7] }], expected: [false] },
        { description: "exact integers", calls: [{ fn: "isExactTotal", args: [[10, 20.5], 30.5] }], expected: [true] },
      ],
    },
  },
  {
    id: "debug-lexicographic-sort",
    category: "debugging",
    title: "Numbers sorted as strings",
    prompt:
      `This function is supposed to sort numbers from largest to smallest:\n\n` +
      "```javascript\n" +
      "function sortDescending(nums) {\n" +
      "  return nums.sort().reverse();\n" +
      "}\n" +
      "```\n\n" +
      "Symptom: `sortDescending([10, 1, 2, 21])` returns `[21, 2, 10, 1]` instead of " +
      "`[21, 10, 2, 1]`. " +
      FIX_INSTRUCTION,
    grader: {
      type: "debug-fix",
      language: "javascript",
      rootCauseKeywords: [
        "lexicograph",
        "comparator",
        "compare function",
        ["string", "sort"],
        ["character", "numeric"],
      ],
      cases: [
        { description: "two-digit numbers", calls: [{ fn: "sortDescending", args: [[10, 1, 2, 21]] }], expected: [[21, 10, 2, 1]] },
        { description: "single digits", calls: [{ fn: "sortDescending", args: [[5, 3, 9, 1]] }], expected: [[9, 5, 3, 1]] },
        { description: "empty array", calls: [{ fn: "sortDescending", args: [[]] }], expected: [[]] },
      ],
    },
  },
  {
    id: "debug-var-closure-in-loop",
    category: "debugging",
    title: "var captured by closures in a loop",
    prompt:
      `This function is supposed to build one greeting closure per name:\n\n` +
      "```javascript\n" +
      "function scheduleGreetings(names) {\n" +
      "  const results = [];\n" +
      "  for (var i = 0; i < names.length; i++) {\n" +
      "    results.push(function () {\n" +
      "      return `Hello, ${names[i]}`;\n" +
      "    });\n" +
      "  }\n" +
      "  return results.map((fn) => fn());\n" +
      "}\n" +
      "```\n\n" +
      'Symptom: `scheduleGreetings(["Ann", "Ben", "Cy"])` returns three copies of ' +
      '`"Hello, undefined"` instead of one greeting per name. ' +
      FIX_INSTRUCTION,
    grader: {
      type: "debug-fix",
      language: "javascript",
      rootCauseKeywords: ["var", "closure", "let", "block scope", "block-scoped", "same variable"],
      cases: [
        {
          description: "three names",
          calls: [{ fn: "scheduleGreetings", args: [["Ann", "Ben", "Cy"]] }],
          expected: [["Hello, Ann", "Hello, Ben", "Hello, Cy"]],
        },
        { description: "single name", calls: [{ fn: "scheduleGreetings", args: [["X"]] }], expected: [["Hello, X"]] },
        { description: "empty list", calls: [{ fn: "scheduleGreetings", args: [[]] }], expected: [[]] },
      ],
    },
  },
];
