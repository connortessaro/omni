// The assessment panel is only as good as the contract parser behind it: a missed
// block means the reader gets a wall of prose on a timed question, and a bad parse
// means a confident verdict pointing at the wrong option. These cover the shapes an
// assessment actually produces, the streaming half-state, and the fall-through that
// keeps ordinary chat turns rendering as markdown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrcModule } from "../harness/loadSrcModule.ts";

interface AssessmentModule {
  parseAnswer(raw: string): {
    shape: string;
    headline: string;
    options: Array<{ label: string; selected: boolean }>;
    confidence: string | null;
    body: string;
    pending: boolean;
  } | null;
  collectCodeBlocks(body: string): Array<{
    path: string | null;
    language: string;
    index: number;
    code: string;
  }>;
  ANSWER_CONTRACT_INSTRUCTIONS: string;
  ASSESSMENT_SYSTEM_PROMPT: string;
}

const load = () => loadSrcModule<AssessmentModule>("lib/assessment.ts");

test("a plain chat answer carries no contract and falls through to markdown", async () => {
  const { parseAnswer } = await load();
  assert.equal(parseAnswer("Sure. Here is a list:\n\n- one\n- two"), null);
  // A code fence alone is not a contract; only the `omni` tag is.
  assert.equal(parseAnswer("```ts\nconst a = 1;\n```"), null);
});

test("a multiple-choice answer surfaces the letters and folds the reasoning", async () => {
  const { parseAnswer } = await load();
  const parsed = parseAnswer(
    [
      "```omni",
      "shape: choice",
      "answer: B",
      "options: A, B*, C, D",
      "confidence: high",
      "```",
      "",
      "`Array.prototype.sort` compares as strings by default.",
    ].join("\n")
  );

  assert.ok(parsed);
  assert.equal(parsed.shape, "choice");
  assert.equal(parsed.headline, "B");
  assert.equal(parsed.confidence, "high");
  assert.deepEqual(parsed.options, [
    { label: "A", selected: false },
    { label: "B", selected: true },
    { label: "C", selected: false },
    { label: "D", selected: false },
  ]);
  assert.equal(parsed.pending, false);
  // The contract block never reaches the markdown renderer.
  assert.ok(!parsed.body.includes("shape:"));
  assert.match(parsed.body, /compares as strings/);
});

test("several correct options are all marked selected", async () => {
  const { parseAnswer } = await load();
  const parsed = parseAnswer(
    ["```omni", "shape: choice", "answer: B, D", "options: A, B*, C, D*", "```"].join(
      "\n"
    )
  );
  assert.ok(parsed);
  assert.deepEqual(
    parsed.options.filter((o) => o.selected).map((o) => o.label),
    ["B", "D"]
  );
});

test("chips are derived from the answer when the model omits the options line", async () => {
  const { parseAnswer } = await load();
  const parsed = parseAnswer(
    ["```omni", "shape: choice", "answer: C", "```", "", "Because the loop is off by one."].join(
      "\n"
    )
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.options, [{ label: "C", selected: true }]);
});

test("a prose answer does not grow option chips out of its sentence", async () => {
  const { parseAnswer } = await load();
  const parsed = parseAnswer(
    ["```omni", "shape: prose", "answer: Cache invalidation is the harder half.", "```", "", "Body."].join(
      "\n"
    )
  );
  assert.ok(parsed);
  assert.equal(parsed.options.length, 0);
  assert.equal(parsed.shape, "prose");
});

test("an unclosed block still paints a provisional verdict while streaming", async () => {
  const { parseAnswer } = await load();
  const parsed = parseAnswer(["```omni", "shape: code", "answer: Two pointers"].join("\n"));

  assert.ok(parsed);
  assert.equal(parsed.pending, true);
  assert.equal(parsed.headline, "Two pointers");
  // Nothing after the open fence may leak into the body, or the reader sees the
  // half-written contract rendered as prose.
  assert.equal(parsed.body, "");
});

test("an unknown shape falls back to what the body actually contains", async () => {
  const { parseAnswer } = await load();
  const parsed = parseAnswer(
    ["```omni", "shape: whiteboard", "answer: Use a trie", "```", "", "```py", "x = 1", "```"].join(
      "\n"
    )
  );
  assert.ok(parsed);
  assert.equal(parsed.shape, "code");
});

test("the file rail names every labelled block in render order", async () => {
  const { collectCodeBlocks } = await load();
  const blocks = collectCodeBlocks(
    [
      "**src/solution.py**",
      "```python",
      "def solve():",
      "    return 1",
      "```",
      "",
      "`tests/test_solution.py`",
      "```python",
      "def test_solve():",
      "    assert solve() == 1",
      "```",
    ].join("\n")
  );

  assert.equal(blocks.length, 2);
  assert.deepEqual(
    blocks.map((b) => b.path),
    ["src/solution.py", "tests/test_solution.py"]
  );
  assert.deepEqual(
    blocks.map((b) => b.index),
    [0, 1]
  );
  assert.equal(blocks[0].language, "python");
  assert.equal(blocks[0].code, "def solve():\n    return 1");
});

test("a path in the info string is read too", async () => {
  const { collectCodeBlocks } = await load();
  const blocks = collectCodeBlocks(
    ["```ts path=src/index.ts", "export const a = 1;", "```"].join("\n")
  );
  assert.equal(blocks[0].path, "src/index.ts");
  assert.equal(blocks[0].language, "ts");
});

test("an unlabelled block reports no path rather than inventing one", async () => {
  const { collectCodeBlocks } = await load();
  const blocks = collectCodeBlocks(
    ["Here is the fix:", "```sql", "SELECT 1;", "```"].join("\n")
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, null);
});

test("a block still streaming keeps its place in the rail", async () => {
  const { collectCodeBlocks } = await load();
  const blocks = collectCodeBlocks(
    [
      "src/a.ts",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "src/b.ts",
      "```ts",
      "const b =",
    ].join("\n")
  );

  // The second block has no closing fence yet. Dropping it would make the rail
  // jump as the stream lands, so it is listed with the code it has so far.
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].path, "src/b.ts");
  assert.equal(blocks[1].code, "");
});

test("path-shaped lines inside a block do not become rail entries", async () => {
  const { collectCodeBlocks } = await load();
  const blocks = collectCodeBlocks(
    ["```python", "# src/other.py", "import os", "```"].join("\n")
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, null);
});

test("the Assessment profile ships the same contract the parser reads", async () => {
  const { ASSESSMENT_SYSTEM_PROMPT, ANSWER_CONTRACT_INSTRUCTIONS, parseAnswer } =
    await load();

  assert.ok(ASSESSMENT_SYSTEM_PROMPT.includes(ANSWER_CONTRACT_INSTRUCTIONS));
  // The example block in the instructions has to be one the parser accepts, or the
  // model is being shown a format that renders as a wall of prose.
  const example = ANSWER_CONTRACT_INSTRUCTIONS.slice(
    ANSWER_CONTRACT_INSTRUCTIONS.indexOf("```omni")
  );
  assert.ok(parseAnswer(example));

  interface BuiltinsModule {
    BUILTIN_SYSTEM_PROMPTS: Array<{ id: number; name: string; prompt: string }>;
  }
  const { BUILTIN_SYSTEM_PROMPTS } = await loadSrcModule<BuiltinsModule>(
    "lib/system-prompts.constants.ts"
  );
  const profile = BUILTIN_SYSTEM_PROMPTS.find((p) => p.name === "Assessment");
  assert.ok(profile, "a built-in profile named Assessment must ship");
  assert.equal(profile.prompt, ASSESSMENT_SYSTEM_PROMPT);
  assert.ok(profile.id < 0, "built-in ids must be negative");
});

test("a spoken answer is a shape of its own", async () => {
  const { parseAnswer } = await load();
  const parsed = parseAnswer(
    [
      "```omni",
      "shape: speak",
      "answer: I'd reach for a hash map, because the lookup has to be constant time.",
      "confidence: high",
      "```",
      "",
      "If they push on memory, the fallback is sorting first and using two pointers.",
    ].join("\n")
  );

  assert.ok(parsed);
  assert.equal(parsed.shape, "speak");
  assert.match(parsed.headline, /hash map/);
  assert.match(parsed.body, /two pointers/);
});

test("a design answer is a shape of its own", async () => {
  const { parseAnswer } = await load();
  const parsed = parseAnswer(
    [
      "```omni",
      "shape: diagram",
      "answer: Fan out on write",
      "```",
      "",
      "```mermaid",
      "graph TD",
      "  A-->B",
      "```",
    ].join("\n")
  );
  assert.ok(parsed);
  assert.equal(parsed.shape, "diagram");
});

test("the two declared-only shapes are never inferred", async () => {
  const { parseAnswer } = await load();
  // `speak` and `diagram` change how the panel reads an answer, so a model that forgot to
  // declare one must fall back to a shape that renders everything, not to one that folds
  // the body away.
  const parsed = parseAnswer(
    ["```omni", "answer: no shape declared", "```", "", "Some prose with no fences."].join(
      "\n"
    )
  );
  assert.ok(parsed);
  assert.ok(["prose", "code", "files", "choice"].includes(parsed.shape));
});
