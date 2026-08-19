import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrcModule } from "../harness/loadSrcModule.ts";

interface HistoryTurn {
  role: string;
  content: string;
}

interface CurrentTurn {
  text: string;
  contextText?: string;
  imagesBase64?: string[];
}

interface BudgetedHistory {
  turns: HistoryTurn[];
  droppedCount: number;
  keptTokens: number;
  availableTokens: number;
  currentTurnTokens: number;
  overflow: boolean;
}

interface BudgetModule {
  DEFAULT_HISTORY_BUDGET: {
    contextWindow: number;
    reserveForOutput: number;
    reserveForSystem: number;
  };
  fitHistoryToBudget: (
    turns: HistoryTurn[],
    currentTurn: string | CurrentTurn
  ) => BudgetedHistory;
  historyBudgetNotice: (droppedCount: number) => string;
  budgetOverflowNotice: (result: BudgetedHistory) => string;
  estimateImageTokens: (base64: string) => number;
}

const {
  DEFAULT_HISTORY_BUDGET,
  fitHistoryToBudget,
  historyBudgetNotice,
  budgetOverflowNotice,
  estimateImageTokens,
} = await loadSrcModule<BudgetModule>("lib/context/budget.ts");

/**
 * A PNG header with the given dimensions and nothing else. The budget only reads
 * IHDR, so this is enough to exercise it without checking in binary fixtures.
 */
const pngBase64 = (width: number, height: number): string => {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header.toString("base64");
};

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

// Attached files and screenshots are the whole point of the repo-level case, and
// until these landed they counted as zero against the window: six source files were
// ~25k tokens of payload that the budget could not see, so it happily kept a full
// history alongside them and the provider rejected the request.

test("attached context counts against the budget", () => {
  const turns = exchange(6, 400);
  const bareResult = fitHistoryToBudget(turns, "question");

  // A current turn near the whole window has to evict everything.
  const withContext = fitHistoryToBudget(turns, {
    text: "question",
    contextText: "z".repeat(600_000),
  });

  assert.equal(bareResult.droppedCount, 0);
  assert.equal(withContext.turns.length, 0, "history must give way to the payload");
  assert.equal(withContext.droppedCount, 6);
});

test("images count against the budget", () => {
  const turns = exchange(6, 400);
  const screenshot = pngBase64(2560, 1600);

  const withoutImage = fitHistoryToBudget(turns, { text: "question" });
  const withImages = fitHistoryToBudget(turns, {
    text: "question",
    imagesBase64: Array.from({ length: 6 }, () => screenshot),
  });

  assert.ok(
    withImages.availableTokens < withoutImage.availableTokens,
    `six full-screen captures must reduce the budget: ` +
      `${withoutImage.availableTokens} -> ${withImages.availableTokens}`
  );
});

test("a full-screen capture is charged more than a small crop", () => {
  assert.ok(
    estimateImageTokens(pngBase64(2560, 1600)) >
      estimateImageTokens(pngBase64(600, 200)),
    "tile count should scale with pixels"
  );
});

test("a non-PNG image is charged a conservative flat estimate", () => {
  // Better to over-charge an unknown format than to let it through as free.
  assert.ok(estimateImageTokens("not-a-png") > 0);
});

test("overflow is reported rather than sent", () => {
  const result = fitHistoryToBudget([], {
    text: "question",
    contextText: "z".repeat(2_000_000),
  });
  assert.equal(result.overflow, true);
  const notice = budgetOverflowNotice(result);
  assert.match(notice, /too large/i);
  assert.match(notice, /remove/i);
});

test("a turn that fits is not reported as overflowing", () => {
  const result = fitHistoryToBudget([], { text: "question" });
  assert.equal(result.overflow, false);
});
