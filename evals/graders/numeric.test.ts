import test from "node:test";
import assert from "node:assert/strict";
import { extractFinalAnswer, gradeNumeric } from "./numeric.ts";

test("extractFinalAnswer reads a plain final answer line", () => {
  assert.equal(extractFinalAnswer("Working through it...\nFinal answer: 42"), 42);
});

test("extractFinalAnswer strips a dollar sign and thousands separators", () => {
  assert.equal(extractFinalAnswer("Final answer: $1,234.50"), 1234.5);
});

test("extractFinalAnswer takes the last occurrence when the model repeats itself", () => {
  const response = "Final answer: 10\n\nWait, let me redo this.\n\nFinal answer: 12";
  assert.equal(extractFinalAnswer(response), 12);
});

test("extractFinalAnswer returns null when the format was not followed", () => {
  assert.equal(extractFinalAnswer("I believe the answer is 42."), null);
});

test("gradeNumeric passes within tolerance and fails outside it", () => {
  const tooFar = gradeNumeric("Final answer: 64.50", 64.8, 0.01);
  assert.equal(tooFar.pass, false);
  const closeEnough = gradeNumeric("Final answer: 64.80", 64.8, 0.01);
  assert.equal(closeEnough.pass, true);
});

test("gradeNumeric fails cleanly when nothing was extracted", () => {
  const result = gradeNumeric("no final answer line here", 3, 0.01);
  assert.equal(result.pass, false);
  assert.equal(result.extracted, null);
  assert.ok(result.error);
});
