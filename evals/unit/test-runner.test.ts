// The run button is only useful if it runs the right file and reads the result
// correctly. Picking the solution instead of the test file reports "ran clean" on an
// answer that was never checked, which is worse than no button at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrcModule } from "../harness/loadSrcModule.ts";

interface RunnerModule {
  buildRunPlan(body: string): {
    language: string;
    files: Array<{ path: string; content: string }>;
    entry: string;
  } | null;
  summarizeRun(result: {
    exit_code: number;
    stdout: string;
    stderr: string;
    timed_out: boolean;
    truncated: boolean;
    duration_ms: number;
    command: string;
  }): {
    status: string;
    headline: string;
    detail: string;
    passed: number | null;
    failed: number | null;
  };
}

const load = () => loadSrcModule<RunnerModule>("lib/test-runner.ts");

const result = (over: Partial<Parameters<RunnerModule["summarizeRun"]>[0]> = {}) => ({
  exit_code: 0,
  stdout: "",
  stderr: "",
  timed_out: false,
  truncated: false,
  duration_ms: 12,
  command: "python3",
  ...over,
});

test("an answer with no code offers nothing to run", async () => {
  const { buildRunPlan } = await load();
  assert.equal(buildRunPlan("Just prose, no fences."), null);
});

test("a language with no local interpreter offers nothing to run", async () => {
  const { buildRunPlan } = await load();
  assert.equal(
    buildRunPlan(["```sql", "SELECT 1;", "```"].join("\n")),
    null
  );
  assert.equal(
    buildRunPlan(["```bash", "rm -rf /", "```"].join("\n")),
    null
  );
});

test("the test file is the entry, not the solution", async () => {
  const { buildRunPlan } = await load();
  const plan = buildRunPlan(
    [
      "src/solution.py",
      "```python",
      "def add(a, b):",
      "    return a + b",
      "```",
      "",
      "tests/test_solution.py",
      "```python",
      "from solution import add",
      "assert add(2, 2) == 4",
      "```",
    ].join("\n")
  );

  assert.ok(plan);
  assert.equal(plan.language, "python");
  assert.equal(plan.entry, "tests/test_solution.py");
  assert.deepEqual(
    plan.files.map((f) => f.path),
    ["src/solution.py", "tests/test_solution.py"]
  );
});

test("an unlabelled pair still runs the half that does the asserting", async () => {
  const { buildRunPlan } = await load();
  const plan = buildRunPlan(
    [
      "```python",
      "def add(a, b):",
      "    return a + b",
      "```",
      "",
      "```python",
      "assert add(2, 2) == 4",
      "```",
    ].join("\n")
  );

  assert.ok(plan);
  // The second block does the checking, so it is the one handed to the interpreter.
  assert.equal(plan.entry, "check_1.py");
  assert.equal(plan.files.length, 2);
});

test("a lone solution block still runs rather than being skipped", async () => {
  const { buildRunPlan } = await load();
  const plan = buildRunPlan(["```python", "print('hello')", "```"].join("\n"));
  assert.ok(plan);
  assert.equal(plan.entry, "solution.py");
});

test("a block repeated under the same path keeps the finished version", async () => {
  const { buildRunPlan } = await load();
  const plan = buildRunPlan(
    [
      "solution.py",
      "```python",
      "def add(a, b):",
      "    pass",
      "```",
      "",
      "solution.py",
      "```python",
      "def add(a, b):",
      "    return a + b",
      "```",
    ].join("\n")
  );

  assert.ok(plan);
  assert.equal(plan.files.length, 1);
  assert.match(plan.files[0].content, /return a \+ b/);
});

test("a second language is left out of a run it cannot join", async () => {
  const { buildRunPlan } = await load();
  const plan = buildRunPlan(
    [
      "```python",
      "assert 1 == 1",
      "```",
      "",
      "```sql",
      "SELECT 1;",
      "```",
    ].join("\n")
  );

  assert.ok(plan);
  assert.equal(plan.language, "python");
  assert.equal(plan.files.length, 1);
});

test("pytest counts are read off the summary line", async () => {
  const { summarizeRun } = await load();
  const summary = summarizeRun(
    result({ exit_code: 1, stdout: "=== 3 passed, 1 failed in 0.12s ===" })
  );
  assert.equal(summary.status, "failed");
  assert.equal(summary.passed, 3);
  assert.equal(summary.failed, 1);
  assert.equal(summary.headline, "1 of 4 failed");
});

test("unittest counts are read off its own format", async () => {
  const { summarizeRun } = await load();
  const summary = summarizeRun(
    result({
      exit_code: 1,
      stderr: "Ran 5 tests in 0.001s\n\nFAILED (failures=2)",
    })
  );
  assert.equal(summary.passed, 3);
  assert.equal(summary.failed, 2);
});

test("node:test counts are read off its own format", async () => {
  const { summarizeRun } = await load();
  const summary = summarizeRun(
    result({ exit_code: 1, stdout: "# pass 4\n# fail 1\n" })
  );
  assert.equal(summary.passed, 4);
  assert.equal(summary.failed, 1);
});

test("a bare assert with no counts still reports pass or fail", async () => {
  const { summarizeRun } = await load();

  const passed = summarizeRun(result({ exit_code: 0, stdout: "ok\n" }));
  assert.equal(passed.status, "passed");
  assert.equal(passed.headline, "Ran clean");

  const failed = summarizeRun(
    result({
      exit_code: 1,
      stderr:
        'Traceback (most recent call last):\n  File "t.py", line 2\n    assert add(2, 2) == 4\nAssertionError: off by one',
    })
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.headline, "Failed (exit 1)");
  // The assertion is what the reader needs, not the frames above it.
  assert.equal(failed.detail, "AssertionError: off by one");
});

test("a timeout is reported as a timeout, not as a failure", async () => {
  const { summarizeRun } = await load();
  const summary = summarizeRun(
    result({ exit_code: -1, timed_out: true, duration_ms: 10_000 })
  );
  assert.equal(summary.status, "timeout");
  assert.match(summary.headline, /Timed out after 10s/);
});

test("a zero exit with failures counted is still a failure", async () => {
  const { summarizeRun } = await load();
  // A runner that swallows its own exit code must not be reported as a pass.
  const summary = summarizeRun(
    result({ exit_code: 0, stdout: "1 passed, 2 failed" })
  );
  assert.equal(summary.status, "failed");
});
