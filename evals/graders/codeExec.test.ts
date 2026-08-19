import test from "node:test";
import assert from "node:assert/strict";
import { gradeCodeExec, extractCode } from "./codeExec.ts";

test("extractCode pulls a fenced javascript block", () => {
  const response = [
    "Here is the function you asked for:",
    "",
    "```javascript",
    "function add(a, b) { return a + b; }",
    "```",
    "",
    "Let me know if you need anything else.",
  ].join("\n");
  const code = extractCode(response);
  assert.ok(code?.includes("function add"));
});

test("extractCode returns null when there is no fenced block", () => {
  assert.equal(extractCode("just prose, no code here"), null);
});

test("gradeCodeExec passes a correct fake model answer", async () => {
  const response = [
    "```javascript",
    "function twoSum(nums, target) {",
    "  const seen = new Map();",
    "  for (let i = 0; i < nums.length; i++) {",
    "    const complement = target - nums[i];",
    "    if (seen.has(complement)) return [seen.get(complement), i];",
    "    seen.set(nums[i], i);",
    "  }",
    "  return [];",
    "}",
    "```",
  ].join("\n");

  const result = await gradeCodeExec(response, [
    {
      description: "basic case",
      calls: [{ fn: "twoSum", args: [[2, 7, 11, 15], 9] }],
      expected: [[0, 1]],
    },
  ]);

  assert.equal(result.pass, true);
  assert.equal(result.cases[0].pass, true);
});

test("gradeCodeExec fails a wrong fake model answer", async () => {
  const response = [
    "```javascript",
    "function twoSum(nums, target) {",
    "  return [0, 0];",
    "}",
    "```",
  ].join("\n");

  const result = await gradeCodeExec(response, [
    {
      description: "basic case",
      calls: [{ fn: "twoSum", args: [[2, 7, 11, 15], 9] }],
      expected: [[0, 1]],
    },
  ]);

  assert.equal(result.pass, false);
  assert.deepEqual(result.cases[0].actual, [[0, 0]]);
});

test("gradeCodeExec fails cleanly when the response has no code block", async () => {
  const result = await gradeCodeExec("I think the answer is [0, 1].", [
    {
      description: "basic case",
      calls: [{ fn: "twoSum", args: [[2, 7, 11, 15], 9] }],
      expected: [[0, 1]],
    },
  ]);

  assert.equal(result.pass, false);
  assert.match(result.extractionError ?? "", /no fenced code block/);
});

test("gradeCodeExec fails cleanly when the submitted function throws", async () => {
  const response = ["```javascript", "function twoSum(nums, target) {", "  throw new Error('nope');", "}", "```"].join(
    "\n"
  );

  const result = await gradeCodeExec(response, [
    {
      description: "basic case",
      calls: [{ fn: "twoSum", args: [[2, 7, 11, 15], 9] }],
      expected: [[0, 1]],
    },
  ]);

  assert.equal(result.pass, false);
  assert.deepEqual(result.cases[0].actual, [{ __threw: "nope" }]);
});

test("gradeCodeExec catches a cross-call shared-reference bug (stateful sequence)", async () => {
  const buggyResponse = [
    "```javascript",
    'const DEFAULT_TAGS = ["new"];',
    "function createProduct(name, tags = DEFAULT_TAGS) {",
    "  tags.push(name.toLowerCase());",
    "  return { name, tags };",
    "}",
    "```",
  ].join("\n");

  const cases = [
    {
      description: "two sequential calls should not share the default tags array",
      calls: [
        { fn: "createProduct", args: ["Widget"] },
        { fn: "createProduct", args: ["Gadget"] },
      ],
      expected: [
        { name: "Widget", tags: ["new", "widget"] },
        { name: "Gadget", tags: ["new", "gadget"] },
      ],
    },
  ];

  const buggy = await gradeCodeExec(buggyResponse, cases);
  assert.equal(buggy.pass, false);

  const fixedResponse = [
    "```javascript",
    'const DEFAULT_TAGS = ["new"];',
    "function createProduct(name, tags = [...DEFAULT_TAGS]) {",
    "  tags.push(name.toLowerCase());",
    "  return { name, tags };",
    "}",
    "```",
  ].join("\n");

  const fixed = await gradeCodeExec(fixedResponse, cases);
  assert.equal(fixed.pass, true);
});
