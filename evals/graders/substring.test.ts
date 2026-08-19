import test from "node:test";
import assert from "node:assert/strict";
import { gradeSubstring } from "./substring.ts";

test("gradeSubstring passes when every expected fact is present", () => {
  const response = "The only ERROR line reports a 503 for /api/v2/inventory/sync.";
  const result = gradeSubstring(response, ["503", "/api/v2/inventory/sync"]);
  assert.equal(result.pass, true);
  assert.deepEqual(result.missing, []);
});

test("gradeSubstring fails and reports what is missing", () => {
  const response = "The endpoint had some kind of server error.";
  const result = gradeSubstring(response, ["503", "/api/v2/inventory/sync"]);
  assert.equal(result.pass, false);
  assert.deepEqual(result.missing, ["503", "/api/v2/inventory/sync"]);
});

test("gradeSubstring is case-insensitive by default", () => {
  const result = gradeSubstring("Priya asked for 14 servers by FRIDAY.", ["friday"]);
  assert.equal(result.pass, true);
});

test("gradeSubstring honors caseSensitive true", () => {
  const result = gradeSubstring("Priya asked for 14 servers by FRIDAY.", ["friday"], true);
  assert.equal(result.pass, false);
});
