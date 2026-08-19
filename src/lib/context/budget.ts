import { estimateTokens } from "./context-block";

export interface HistoryBudget {
  /** Total context the model accepts. */
  contextWindow: number;
  /** Held back for the answer, so a long reply is not cut off. */
  reserveForOutput: number;
  /** Held back for the system prompt and its stacked instructions. */
  reserveForSystem: number;
}

/**
 * Conservative defaults: every provider Omni ships with accepts at least this
 * much. Deliberately no tokenizer dependency, since loading one would cost
 * cold-start time in a HUD whose whole value is summoning instantly. The goal
 * is avoiding a hard provider error, not exact accounting.
 */
export const DEFAULT_HISTORY_BUDGET: HistoryBudget = {
  contextWindow: 128_000,
  reserveForOutput: 8_192,
  reserveForSystem: 2_000,
};

/** Character heuristics run short on dense text, so keep headroom. */
const SAFETY_FRACTION = 0.85;

export interface HistoryTurn {
  role: string;
  content: string;
}

export interface BudgetedHistory<T extends HistoryTurn> {
  turns: T[];
  droppedCount: number;
  keptTokens: number;
}

export const historyBudgetNotice = (droppedCount: number): string =>
  `Dropped ${droppedCount} earlier ${
    droppedCount === 1 ? "turn" : "turns"
  } to stay inside the model's context window.`;

/**
 * Keeps the newest turns that fit, drops the oldest, and reports how many went.
 * Returns turns in their original order so the conversation still reads forward.
 */
export const fitHistoryToBudget = <T extends HistoryTurn>(
  turns: T[],
  currentTurnText: string,
  budget: HistoryBudget = DEFAULT_HISTORY_BUDGET
): BudgetedHistory<T> => {
  const available = Math.floor(
    (budget.contextWindow -
      budget.reserveForOutput -
      budget.reserveForSystem -
      estimateTokens(currentTurnText)) *
      SAFETY_FRACTION
  );

  if (available <= 0) {
    return { turns: [], droppedCount: turns.length, keptTokens: 0 };
  }

  const kept: T[] = [];
  let keptTokens = 0;

  // Newest first: the most recent exchange is the most likely to matter.
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const cost = estimateTokens(turn.content);
    if (keptTokens + cost > available) break;
    keptTokens += cost;
    kept.push(turn);
  }

  kept.reverse();
  return {
    turns: kept,
    droppedCount: turns.length - kept.length,
    keptTokens,
  };
};
