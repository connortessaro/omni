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

/**
 * Providers bill an image by tiling it, so the cost scales with pixels rather than
 * with the encoded byte count: a 2560x1600 screen grab and a cropped region can be
 * the same number of kilobytes and an order of magnitude apart in tokens.
 *
 * These match the tiling Gemini and the OpenAI-shaped providers document, which is
 * close enough for a budget whose job is avoiding a hard failure.
 */
const IMAGE_TILE_PIXELS = 768;
const TOKENS_PER_IMAGE_TILE = 258;

/**
 * Charged when the dimensions cannot be read. Higher than a single tile on purpose:
 * an unknown image should cost too much rather than nothing, because counting it as
 * free is how a request ends up rejected by the provider.
 */
const UNKNOWN_IMAGE_TOKENS = 4_000;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Width and height out of a PNG's IHDR chunk, which sits at a fixed offset right
 * after the 8-byte signature. Avoids decoding the image, and avoids a dependency.
 */
const pngDimensions = (
  base64: string
): { width: number; height: number } | null => {
  // 33 base64 characters cover the 24 bytes through the end of IHDR's height.
  const head = base64.slice(0, 64);
  let bytes: Uint8Array;
  try {
    const binary = atob(head);
    bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }

  if (bytes.length < 24) return null;
  if (PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null;

  const readUint32 = (offset: number): number =>
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0;

  const width = readUint32(16);
  const height = readUint32(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
};

export const estimateImageTokens = (base64: string): number => {
  const dimensions = pngDimensions(base64);
  if (!dimensions) return UNKNOWN_IMAGE_TOKENS;

  const tiles =
    Math.ceil(dimensions.width / IMAGE_TILE_PIXELS) *
    Math.ceil(dimensions.height / IMAGE_TILE_PIXELS);
  // One tile's worth of overhead for the image itself, then the tiles.
  return TOKENS_PER_IMAGE_TILE * (tiles + 1);
};

export interface HistoryTurn {
  role: string;
  content: string;
}

/**
 * Everything the current turn will send. Attached files and screenshots are the
 * bulk of it in the case this exists for, and until they were counted here they
 * counted as zero: six source files were ~25k tokens the budget could not see, so it
 * kept a full history alongside them and the provider rejected the request.
 */
export interface CurrentTurn {
  /** What the user typed, after slash-command expansion. */
  text: string;
  /** Attached files and long pastes, already rendered for the prompt. */
  contextText?: string;
  imagesBase64?: string[];
}

export interface BudgetedHistory<T extends HistoryTurn> {
  turns: T[];
  droppedCount: number;
  keptTokens: number;
  /** What was left for history after the current turn was accounted for. */
  availableTokens: number;
  currentTurnTokens: number;
  /** The current turn alone does not fit, so dropping history cannot help. */
  overflow: boolean;
}

export const historyBudgetNotice = (droppedCount: number): string =>
  `Dropped ${droppedCount} earlier ${
    droppedCount === 1 ? "turn" : "turns"
  } to stay inside the model's context window.`;

/**
 * Says what to remove, since no amount of dropped history will make this fit.
 */
export const budgetOverflowNotice = <T extends HistoryTurn>(
  result: BudgetedHistory<T>
): string =>
  `This turn is too large for the model's context window ` +
  `(about ${Math.round(result.currentTurnTokens / 1000)}k tokens). ` +
  `Remove an attached file or a screenshot and send it again.`;

const currentTurnCost = (currentTurn: string | CurrentTurn): number => {
  if (typeof currentTurn === "string") return estimateTokens(currentTurn);

  const textTokens = estimateTokens(currentTurn.text);
  const contextTokens = currentTurn.contextText
    ? estimateTokens(currentTurn.contextText)
    : 0;
  const imageTokens = (currentTurn.imagesBase64 ?? []).reduce(
    (total, image) => total + estimateImageTokens(image),
    0
  );
  return textTokens + contextTokens + imageTokens;
};

/**
 * Keeps the newest turns that fit, drops the oldest, and reports how many went.
 * Returns turns in their original order so the conversation still reads forward.
 */
export const fitHistoryToBudget = <T extends HistoryTurn>(
  turns: T[],
  currentTurn: string | CurrentTurn,
  budget: HistoryBudget = DEFAULT_HISTORY_BUDGET
): BudgetedHistory<T> => {
  const currentTurnTokens = currentTurnCost(currentTurn);

  const forConversation = Math.floor(
    (budget.contextWindow - budget.reserveForOutput - budget.reserveForSystem) *
      SAFETY_FRACTION
  );
  const available = forConversation - currentTurnTokens;

  if (available <= 0) {
    return {
      turns: [],
      droppedCount: turns.length,
      keptTokens: 0,
      availableTokens: 0,
      currentTurnTokens,
      overflow: currentTurnTokens > forConversation,
    };
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
    availableTokens: available,
    currentTurnTokens,
    overflow: false,
  };
};
