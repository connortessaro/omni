import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrcModule } from "../harness/loadSrcModule.ts";

interface HistoryTurn {
  role: string;
  content: string;
}

interface BudgetModule {
  DEFAULT_HISTORY_BUDGET: {
    contextWindow: number;
    reserveForOutput: number;
    reserveForSystem: number;
  };
  fitHistoryToBudget: (
    turns: HistoryTurn[],
    currentTurnText: string
  ) => { turns: HistoryTurn[]; droppedCount: number; keptTokens: number };
  historyBudgetNotice: (droppedCount: number) => string;
}

const { DEFAULT_HISTORY_BUDGET, fitHistoryToBudget, historyBudgetNotice } =
  await loadSrcModule<BudgetModule>("lib/context/budget.ts");

const turn = (role: string, chars: number): HistoryTurn => ({
  role,
  content: "x".repeat(chars),
});

const exchange = (count: number, chars: number): HistoryTurn[] =>
  Array.from({ length: count }, (_, i) =>
    turn(i % 2 === 0 ? "user" : "assistant", chars)
  );

test("keeps everything when the history fits", () => {
  const turns = exchange(6, 400);
  const result = fitHistoryToBudget(turns, "a short question");
  assert.equal(result.droppedCount, 0);
  assert.equal(result.turns.length, 6);
});

test("drops the oldest turns when the history does not fit", () => {
  // 40 turns x 40k chars is far past a 128k-token window.
  const turns = exchange(40, 40_000);
  const result = fitHistoryToBudget(turns, "question");
  assert.ok(result.droppedCount > 0, "expected some turns to be dropped");
  assert.equal(result.turns.length + result.droppedCount, 40);
});

test("keeps the newest turns, not the oldest", () => {
  const turns: HistoryTurn[] = [
    { role: "user", content: "oldest" },
    // Comfortably past a 128k-token window, so nothing older can survive.
    { role: "assistant", content: "x".repeat(600_000) },
    { role: "user", content: "newest" },
  ];
  const result = fitHistoryToBudget(turns, "question");
  assert.equal(result.turns[result.turns.length - 1]?.content, "newest");
  assert.ok(
    !result.turns.some((t) => t.content === "oldest"),
    "the oldest turn should have been evicted first"
  );
});

test("preserves chronological order in what it keeps", () => {
  const turns: HistoryTurn[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: "second" },
    { role: "user", content: "third" },
  ];
  const result = fitHistoryToBudget(turns, "question");
  assert.deepEqual(
    result.turns.map((t) => t.content),
    ["first", "second", "third"]
  );
});

test("a huge current turn evicts history rather than overflowing", () => {
  const turns = exchange(4, 1_000);
  const enormous = "y".repeat(600_000);
  const result = fitHistoryToBudget(turns, enormous);
  assert.equal(result.turns.length, 0);
  assert.equal(result.droppedCount, 4);
  assert.equal(result.keptTokens, 0);
});

test("never exceeds the available budget", () => {
  const turns = exchange(60, 20_000);
  const result = fitHistoryToBudget(turns, "question");
  const ceiling =
    DEFAULT_HISTORY_BUDGET.contextWindow -
    DEFAULT_HISTORY_BUDGET.reserveForOutput -
    DEFAULT_HISTORY_BUDGET.reserveForSystem;
  assert.ok(
    result.keptTokens < ceiling,
    `kept ${result.keptTokens} tokens, ceiling is ${ceiling}`
  );
});

test("empty history is not an error", () => {
  const result = fitHistoryToBudget([], "question");
  assert.deepEqual(result.turns, []);
  assert.equal(result.droppedCount, 0);
});

test("notice is singular for one dropped turn", () => {
  assert.match(historyBudgetNotice(1), /1 earlier turn /);
  assert.match(historyBudgetNotice(4), /4 earlier turns /);
});
