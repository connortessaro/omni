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
