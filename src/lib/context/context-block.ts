export type ContextBlockKind = "paste" | "file";

export interface ContextBlock {
  id: string;
  kind: ContextBlockKind;
  label: string;
  language?: string;
  text: string;
  bytes: number;
  approxTokens: number;
}

/** Pasted text longer than this becomes a context block instead of filling the prompt box. */
export const PASTE_AS_BLOCK_THRESHOLD = 800;

/** Hard ceiling on a single block, so one huge file cannot stall the HUD. */
export const MAX_BLOCK_BYTES = 256 * 1024;

const CODE_CHARS_PER_TOKEN = 3.6;
const PROSE_CHARS_PER_TOKEN = 4;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  rb: "ruby",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  sql: "sql",
  html: "html",
  css: "css",
  scss: "scss",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  md: "markdown",
  mdx: "mdx",
  diff: "diff",
  patch: "diff",
  txt: "",
  log: "",
  csv: "",
  env: "",
};

/** File picker filter. Extensions only: browsers report inconsistent MIME types for source files. */
export const TEXT_FILE_ACCEPT = Object.keys(LANGUAGE_BY_EXTENSION)
  .map((ext) => `.${ext}`)
  .join(",");

const extensionOf = (name: string): string =>
  name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";

export const languageFromFilename = (name: string): string | undefined =>
  LANGUAGE_BY_EXTENSION[extensionOf(name)] || undefined;

/**
 * Extension wins over MIME type on purpose: browsers report `.ts` as `video/mp2t`
 * and source files frequently arrive with an empty type.
 */
export const isTextFile = (file: File): boolean =>
  extensionOf(file.name) in LANGUAGE_BY_EXTENSION ||
  file.type.startsWith("text/");

export const estimateTokens = (text: string, language?: string): number => {
  const charsPerToken = language ? CODE_CHARS_PER_TOKEN : PROSE_CHARS_PER_TOKEN;
  return Math.ceil(text.length / charsPerToken);
};

export const formatTokenCount = (tokens: number): string =>
  tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k tok` : `~${tokens} tok`;

const countLines = (text: string): number => text.split("\n").length;

const nextBlockId = (): string =>
  `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const looksLikeCode = (text: string): boolean =>
  /[{};]\s*$|^\s*(import|export|function|const|let|var|class|def|fn|public|private)\s/m.test(
    text
  );

export const createPasteBlock = (text: string): ContextBlock => {
  const isCode = looksLikeCode(text);
  return {
    id: nextBlockId(),
    kind: "paste",
    label: `clipboard, ${countLines(text)} lines`,
    text,
    bytes: new Blob([text]).size,
    approxTokens: estimateTokens(text, isCode ? "code" : undefined),
  };
};

export const createFileBlock = (
  filename: string,
  text: string
): ContextBlock => {
  const language = languageFromFilename(filename);
  return {
    id: nextBlockId(),
    kind: "file",
    label: filename,
    language,
    text,
    bytes: new Blob([text]).size,
    approxTokens: estimateTokens(text, language),
  };
};

/** Fence must outrun any backtick run inside the content, or the block breaks out early. */
const fenceFor = (text: string): string => {
  const longestRun = (text.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0
  );
  return "`".repeat(Math.max(3, longestRun + 1));
};

/**
 * Renders blocks ahead of the user's request. Long content first, question last:
 * that ordering is what the providers recommend for large inputs.
 */
export const renderBlocksAsText = (blocks: ContextBlock[]): string => {
  if (blocks.length === 0) return "";

  const sections = blocks.map((block, index) => {
    const fence = fenceFor(block.text);
    const heading = `### ${index + 1}. ${block.label}${
      block.language ? ` (${block.language})` : ""
    }`;
    return `${heading}\n${fence}${block.language ?? ""}\n${block.text}\n${fence}`;
  });

  const noun = blocks.length === 1 ? "item" : "items";
  return [
    `Attached context (${blocks.length} ${noun}). Answer the request that follows using it.`,
    ...sections,
  ].join("\n\n");
};
