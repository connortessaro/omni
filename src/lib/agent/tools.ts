import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { getAllConversations } from "../database";

/**
 * Tools the model can call, and the text protocol used to call them.
 *
 * The protocol is deliberately text rather than a provider's native tool-calling
 * schema. Providers disagree on that schema, users bring their own curl
 * templates, and local models through Ollama often support no schema at all. A
 * fenced block any instruction-following model can emit works everywhere, and
 * the worst failure mode is the model answering in prose, which is exactly what
 * it does today.
 */

export const TOOL_FENCE_LANGUAGE = "omni:tool";

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  name: string;
  ok: boolean;
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  argsHint: string;
  run(args: Record<string, unknown>): Promise<string>;
}

/** Hosts a model must not be able to reach by asking. */
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /\.local$/i,
  /^metadata\./i,
];

const MAX_FETCH_BYTES = 200_000;

/**
 * Strips tags and collapses whitespace. Not a parser: the goal is getting
 * readable text into the context window, not fidelity.
 */
const htmlToText = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

export const isBlockedUrl = (raw: string): string | null => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `unsupported scheme "${url.protocol}"`;
  }
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname))) {
    return "refusing to reach a private or loopback address";
  }
  return null;
};

const fetchUrl: ToolDefinition = {
  name: "fetch_url",
  description:
    "Read a public web page as text. Use it to check documentation or a fact rather than guessing.",
  argsHint: '{"url":"https://example.com/page"}',
  async run(args) {
    const url = String(args.url ?? "");
    const blocked = isBlockedUrl(url);
    if (blocked) throw new Error(`Cannot fetch ${url}: ${blocked}`);

    const response = await tauriFetch(url, {
      method: "GET",
      headers: { Accept: "text/html,text/plain,application/json" },
    });
    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`);
    }

    const body = (await response.text()).slice(0, MAX_FETCH_BYTES);
    const looksHtml = /^\s*<(!doctype|html)/i.test(body) || body.includes("</p>");
    return looksHtml ? htmlToText(body) : body;
  },
};

const MAX_HISTORY_MATCHES = 5;
const SNIPPET_RADIUS = 240;

const searchChatHistory: ToolDefinition = {
  name: "search_chat_history",
  description:
    "Search this machine's own past conversations for something discussed earlier.",
  argsHint: '{"query":"postgres migration"}',
  async run(args) {
    const query = String(args.query ?? "").trim().toLowerCase();
    if (!query) throw new Error("search_chat_history needs a query");

    const conversations = await getAllConversations();
    const matches: string[] = [];

    for (const conversation of conversations) {
      for (const message of conversation.messages) {
        const index = message.content.toLowerCase().indexOf(query);
        if (index === -1) continue;

        const start = Math.max(0, index - SNIPPET_RADIUS);
        const snippet = message.content
          .slice(start, index + query.length + SNIPPET_RADIUS)
          .replace(/\s+/g, " ")
          .trim();
        matches.push(
          `[${conversation.title}] ${message.role}: ${start > 0 ? "..." : ""}${snippet}`
        );
        if (matches.length >= MAX_HISTORY_MATCHES) break;
      }
      if (matches.length >= MAX_HISTORY_MATCHES) break;
    }

    return matches.length > 0
      ? matches.join("\n\n")
      : `No past conversation mentions "${query}".`;
  },
};

export const TOOLS: Record<string, ToolDefinition> = {
  [fetchUrl.name]: fetchUrl,
  [searchChatHistory.name]: searchChatHistory,
};

export type ToolName = keyof typeof TOOLS & string;

export const buildToolInstructions = (names: string[]): string => {
  const available = names
    .map((name) => TOOLS[name])
    .filter((tool): tool is ToolDefinition => Boolean(tool));

  if (available.length === 0) return "";

  const catalog = available
    .map((tool) => `- ${tool.name} ${tool.argsHint}\n  ${tool.description}`)
    .join("\n");

  return [
    "You can call a tool before answering, when a tool would give you a fact you would otherwise have to guess.",
    "",
    "To call one, emit exactly one fenced block and stop. Write nothing after it:",
    "",
    "```" + TOOL_FENCE_LANGUAGE,
    '{"name":"tool_name","args":{...}}',
    "```",
    "",
    "The result comes back as the next message, then you continue. Call at most one tool per turn.",
    "Do not describe calling a tool, and do not show the block to the user as part of an answer.",
    "If no tool helps, just answer.",
    "",
    "Available tools:",
    catalog,
  ].join("\n");
};

/**
 * Finds a completed tool-call block. Returns null while the block is still
 * streaming, so a caller can watch a growing buffer and act the moment one
 * closes.
 */
export const parseToolCall = (
  text: string
): { call: ToolCall; raw: string } | null => {
  const opening = new RegExp("```" + TOOL_FENCE_LANGUAGE + "\\s*\\n");
  const openMatch = opening.exec(text);
  if (!openMatch) return null;

  const bodyStart = openMatch.index + openMatch[0].length;
  const closeIndex = text.indexOf("```", bodyStart);
  if (closeIndex === -1) return null;

  const body = text.slice(bodyStart, closeIndex).trim();
  try {
    const parsed = JSON.parse(body) as { name?: unknown; args?: unknown };
    if (typeof parsed.name !== "string" || !parsed.name) return null;
    return {
      call: {
        name: parsed.name,
        args:
          parsed.args && typeof parsed.args === "object"
            ? (parsed.args as Record<string, unknown>)
            : {},
      },
      raw: text.slice(openMatch.index, closeIndex + 3),
    };
  } catch {
    return null;
  }
};

const MAX_TOOL_RESULT_CHARS = 12_000;

export const runToolCall = async (call: ToolCall): Promise<ToolResult> => {
  const tool = TOOLS[call.name];
  if (!tool) {
    return {
      name: call.name,
      ok: false,
      content: `No tool named "${call.name}". Available: ${Object.keys(TOOLS).join(", ")}.`,
    };
  }

  try {
    const content = await tool.run(call.args);
    return {
      name: call.name,
      ok: true,
      content: content.slice(0, MAX_TOOL_RESULT_CHARS),
    };
  } catch (error) {
    return {
      name: call.name,
      ok: false,
      content: error instanceof Error ? error.message : String(error),
    };
  }
};

export const renderToolResult = (result: ToolResult): string =>
  [
    `Result of ${result.name} (${result.ok ? "ok" : "failed"}):`,
    result.content,
    "",
    result.ok
      ? "Answer the original request using this. Call another tool only if you still cannot answer."
      : "The tool failed. Either try different arguments once, or answer without it and say what you could not check.",
  ].join("\n");
