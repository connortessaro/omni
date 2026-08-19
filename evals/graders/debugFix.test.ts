import test from "node:test";
import assert from "node:assert/strict";
import { gradeDebugFix } from "./debugFix.ts";

const cases = [
  {
    description: "half-open range sum",
    calls: [{ fn: "sumRange", args: [[10, 20, 30, 40, 50], 1, 3] }],
    expected: [50],
  },
];

test("gradeDebugFix fails when the fix is correct but the explanation omits the root cause", async () => {
  const response = [
    "I changed the loop.",
    "",
    "```javascript",
    "function sumRange(arr, start, end) {",
    "  let sum = 0;",
    "  for (let i = start; i < end; i++) sum += arr[i];",
    "  return sum;",
    "}",
    "```",
  ].join("\n");

  const result = await gradeDebugFix(response, cases, ["off-by-one", "off by one", "boundary"]);
  assert.equal(result.testsPass, true);
  assert.equal(result.rootCauseIdentified, false);
  assert.equal(result.pass, false);
});

test("gradeDebugFix fails when the explanation is right but the fix is not applied", async () => {
  const response = [
    "This is an off-by-one error in the loop condition.",
    "",
    "```javascript",
    "function sumRange(arr, start, end) {",
    "  let sum = 0;",
    "  for (let i = start; i <= end; i++) sum += arr[i];",
    "  return sum;",
    "}",
    "```",
  ].join("\n");

  const result = await gradeDebugFix(response, cases, ["off-by-one"]);
  assert.equal(result.rootCauseIdentified, true);
  assert.equal(result.testsPass, false);
  assert.equal(result.pass, false);
});

test("gradeDebugFix passes when both the explanation and the fix are correct", async () => {
  const response = [
    "Root cause: classic off-by-one error, the loop used `<=` instead of `<`.",
    "",
    "```javascript",
    "function sumRange(arr, start, end) {",
    "  let sum = 0;",
    "  for (let i = start; i < end; i++) sum += arr[i];",
    "  return sum;",
    "}",
    "```",
  ].join("\n");

  const result = await gradeDebugFix(response, cases, ["off-by-one"]);
  assert.equal(result.pass, true);
  assert.equal(result.matchedKeyword, "off-by-one");
});

test("an AND-group entry needs every term, not just one", async () => {
  const cases = [
    {
      description: "descending",
      calls: [{ fn: "sortDescending", args: [[10, 1, 2, 21]] }],
      expected: [[21, 10, 2, 1]],
    },
  ];
  const fix =
    "```javascript\nfunction sortDescending(nums) { return nums.sort((a, b) => b - a); }\n```";

  // The phrasing that used to be scored as a miss.
  const realWorldAnswer =
    "sort() without a compare function sorts elements as strings by default. " +
    fix;
  const matched = await gradeDebugFix(realWorldAnswer, cases, [
    ["string", "sort"],
  ]);
  assert.equal(matched.rootCauseIdentified, true);
  assert.equal(matched.pass, true);

  // Only one of the two terms present, so the group must not match.
  const halfAnswer = "the array is sorted incorrectly. " + fix;
  const missed = await gradeDebugFix(halfAnswer, cases, [["string", "sort"]]);
  assert.equal(missed.rootCauseIdentified, false);
  assert.equal(missed.testsPass, true, "the fix itself still works");
  assert.equal(missed.pass, false);
});
