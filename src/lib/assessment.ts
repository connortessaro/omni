/**
 * Assessment answers: a contract the model fills in, and the parser that turns it
 * into something the HUD can render at a glance.
 *
 * A timed assessment question is read under pressure, so the panel cannot make the
 * reader hunt for the payload inside a paragraph. The model puts the payload in a
 * fenced `omni` block at the top of the answer; everything after it is ordinary
 * markdown and is still rendered as markdown. When the block is absent the parser
 * returns null and the caller falls back to the plain renderer, so a normal chat
 * turn is unaffected.
 */

/**
 * Six shapes cover every task an assessment or an interview throws at the reader, and
 * each one wants a different thing on screen first:
 * - `choice`   the option letters (multiple choice, matrix, output-only)
 * - `code`     one runnable block (single function, recovery, bugfix, SQL, regex)
 * - `files`    several blocks, each belonging to a path (filesystem, frontend)
 * - `prose`    text to read or transcribe (writing, conversation)
 * - `speak`    a sentence to say out loud, with the rest held back
 * - `diagram`  a design that leads with its graph
 */
export type AnswerShape =
  | "choice"
  | "code"
  | "files"
  | "prose"
  | "speak"
  | "diagram";

export type AnswerConfidence = "high" | "medium" | "low";

export interface AnswerOption {
  /** The label as the question showed it: "A", "3", "True". */
  label: string;
  selected: boolean;
}

export interface ParsedAnswer {
  shape: AnswerShape;
  /** The one thing to transcribe: option letters, an output literal, a summary. */
  headline: string;
  /** Empty for every shape but `choice`. */
  options: AnswerOption[];
  confidence: AnswerConfidence | null;
  /** The answer with the contract block removed, still markdown. */
  body: string;
  /** The block has opened but not closed yet, so the verdict can still change. */
  pending: boolean;
}

export interface CodeBlockRef {
  /** The path the block was labelled with, or null when it carried none. */
  path: string | null;
  language: string;
  /** Position among the rendered `<pre>` elements, which is what the rail scrolls to. */
  index: number;
  code: string;
}

const SHAPES: AnswerShape[] = [
  "choice",
  "code",
  "files",
  "prose",
  "speak",
  "diagram",
];
const CONFIDENCES: AnswerConfidence[] = ["high", "medium", "low"];

const OPEN_FENCE = /^[ \t]*```[ \t]*omni[ \t]*$/m;
const CLOSE_FENCE = /^[ \t]*```[ \t]*$/m;

/**
 * The instruction that makes a model fill the contract in. Kept next to the parser
 * on purpose: the two have to describe the same block, and splitting them across
 * files is how they drift.
 */
export const ANSWER_CONTRACT_INSTRUCTIONS = [
  "Open every answer with a fenced block tagged `omni`, before any other text:",
  "",
  "```omni",
  "shape: choice | code | files | prose",
  "answer: <the single thing to transcribe, on one line>",
  "options: <choice only: every option label in the order shown, a * on each correct one>",
  "confidence: high | medium | low",
  "```",
  "",
  "Pick `choice` for multiple choice, matching, and fill-in-the-blank output questions, and put the",
  "chosen labels in `answer` (comma separated when more than one is correct). Pick `code` for a single",
  "function, query, or patch, and put a one-line description of the approach in `answer`. Pick `files`",
  "when the solution spans more than one file, and name every file you touched in `answer`. Pick `prose`",
  "for written or spoken answers, and put the thesis sentence in `answer`.",
  "",
  "After the block, write the full solution as normal markdown. Fence every code block with its language",
  "and, when more than one file is involved, put the file path on its own line directly above the fence.",
  "",
  "For `code` and `files` in Python, JavaScript or TypeScript, end with one more fenced block that checks",
  "the solution and exits non-zero when it is wrong: plain asserts are enough, and the question's own",
  "examples are the cases to use. Label it with a path containing `test` and import the solution from the",
  "file you put it in. The reader runs that block locally before transcribing anything.",
  "Never abbreviate code: no ellipses, no `// rest unchanged`. Say `confidence: low` rather than guessing",
  "silently, and name the part you are unsure about in one line.",
].join("\n");

/**
 * Appended by the profiles that pin a shape the generic contract does not offer. Kept as
 * an override rather than a fifth and sixth entry in the shape menu above: an assessment
 * answer must never come back as `speak`, and a spoken answer must never come back as
 * `files`.
 */
export const SPEAK_SHAPE_OVERRIDE = [
  "Override: always write `shape: speak` on this profile. Ignore the other shapes.",
  "`answer` is the single sentence to say out loud, in first person, plain spoken English:",
  "no markdown, no bullets, no code fences, no headings. Aim for what fits in about fifteen",
  "seconds. Everything after the block is what to say only if they follow up, one short",
  "line per point.",
].join("\n");

export const DIAGRAM_SHAPE_OVERRIDE = [
  "Override: always write `shape: diagram` on this profile. Ignore the other shapes.",
  "`answer` is the one-line thesis of the design. Immediately after the block, before any",
  "prose, emit a ```mermaid graph of the architecture. Prose comes after the graph.",
].join("\n");

/**
 * The selectable profile that turns the whole session into assessment answers. The
 * Code profile is the right neighbour to compare it to: that one is about complete,
 * runnable code, and this one adds the verdict the reader needs before the code.
 */
export const ASSESSMENT_SYSTEM_PROMPT = [
  "You are answering a timed technical assessment question shown on the user's screen. The reader has",
  "minutes, not hours, and has to transcribe your answer, so lead with the answer and justify it second.",
  "",
  ANSWER_CONTRACT_INSTRUCTIONS,
  "",
  "Read the question from the screenshot or pasted text before answering. Quote the parts you depend on,",
  "character for character, and say which part you cannot read rather than filling it in. Match the",
  "language, function signature, and file layout the question already uses. When the question includes",
  "tests or examples, check your answer against every one of them and say so.",
].join("\n");

const parseOptions = (raw: string): AnswerOption[] =>
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const selected = entry.includes("*");
      // Labels arrive as "A", "A*", "A)", "(A)" depending on how the question
      // printed them; the rail only needs the character the reader clicks.
      const label = entry
        .replace(/\*/g, "")
        .replace(/^[([]|[)\].:]$/g, "")
        .trim();
      return { label, selected };
    })
    .filter((option) => option.label.length > 0);

const inferShape = (body: string, options: AnswerOption[]): AnswerShape => {
  if (options.length > 0) return "choice";
  const fences = body.match(/^[ \t]*```/gm)?.length ?? 0;
  if (fences >= 4) return "files";
  if (fences >= 2) return "code";
  return "prose";
};

/**
 * Returns null when the response carries no contract block, which is the signal to
 * render it as ordinary markdown instead.
 */
export const parseAnswer = (raw: string): ParsedAnswer | null => {
  const open = OPEN_FENCE.exec(raw);
  if (!open) return null;

  const afterOpen = open.index + open[0].length;
  const rest = raw.slice(afterOpen);
  const close = CLOSE_FENCE.exec(rest);

  // A block that has not closed yet is the normal state for the first moments of a
  // stream. Parse what arrived so the shape and answer can paint as they land, and
  // mark the verdict provisional rather than showing a half-written fence.
  const pending = !close;
  const fields = pending ? rest : rest.slice(0, close.index);
  const body = pending
    ? raw.slice(0, open.index).trim()
    : `${raw.slice(0, open.index)}\n${rest.slice(
        close.index + close[0].length
      )}`.trim();

  const values: Record<string, string> = {};
  for (const line of fields.split("\n")) {
    const match = /^\s*([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
    if (match) values[match[1].toLowerCase()] = match[2].trim();
  }

  const options = values.options ? parseOptions(values.options) : [];

  // A model that omits `options` but answers "B, D" still gives the reader
  // something to check against, so the chips are built from the answer itself.
  const derived =
    options.length > 0 || !values.answer
      ? options
      : /^[A-Za-z0-9]{1,3}(\s*,\s*[A-Za-z0-9]{1,3})*$/.test(values.answer)
      ? parseOptions(values.answer.replace(/([A-Za-z0-9]+)/g, "$1*"))
      : [];

  const declared = values.shape?.toLowerCase() as AnswerShape | undefined;
  const shape =
    declared && SHAPES.includes(declared)
      ? declared
      : inferShape(body, derived);

  const confidence = values.confidence?.toLowerCase() as
    | AnswerConfidence
    | undefined;

  return {
    shape,
    headline: values.answer ?? "",
    options: shape === "choice" ? derived : [],
    confidence:
      confidence && CONFIDENCES.includes(confidence) ? confidence : null,
    body,
    pending,
  };
};

/** A line that is nothing but a file path, which is how a path above a fence reads. */
const PATH_LINE = /^[\s>*_`#-]*([\w@][\w./@+-]*\.[A-Za-z0-9]{1,8})[`*_:\s]*$/;

const pathFromInfo = (info: string): string | null => {
  const tagged = /(?:path|file|title)\s*=\s*["']?([^"'\s]+)/i.exec(info);
  if (tagged) return tagged[1];
  const bare = info
    .trim()
    .split(/\s+/)
    .slice(1)
    .find((token) => /\.[A-Za-z0-9]{1,8}$/.test(token));
  return bare ?? null;
};

/**
 * Walks the rendered markdown for fenced blocks so the panel can offer a jump rail.
 * `index` is the block's position among the fences, which matches the order of the
 * `<pre>` elements the markdown renderer emits.
 */
export const collectCodeBlocks = (body: string): CodeBlockRef[] => {
  const lines = body.split("\n");
  const blocks: CodeBlockRef[] = [];
  let openedAt = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const fence = /^[ \t]*```(.*)$/.exec(lines[i]);
    if (!fence) continue;

    if (openedAt >= 0) {
      blocks[blocks.length - 1].code = lines
        .slice(openedAt + 1, i)
        .join("\n");
      openedAt = -1;
      continue;
    }
    openedAt = i;

    const info = fence[1].trim();
    const language = info.split(/\s+/)[0] || "text";

    // The path sits either in the info string or on the line above the fence, and
    // that line is often bold or a heading because the model was told to label it.
    let path = pathFromInfo(info);
    for (let back = i - 1; back >= 0 && back >= i - 2 && !path; back -= 1) {
      const previous = lines[back].trim();
      if (!previous) continue;
      const match = PATH_LINE.exec(previous);
      path = match ? match[1] : null;
      break;
    }

    // `code` is filled in when the closing fence is reached; a block the stream has
    // not finished yet stays empty rather than being dropped, so the rail is stable.
    blocks.push({ path, language, index: blocks.length, code: "" });
  }

  return blocks;
};
