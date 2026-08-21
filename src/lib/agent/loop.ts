import { Message, TYPE_PROVIDER } from "@/types";
import {
  buildToolInstructions,
  parseToolCall,
  renderToolResult,
  runToolCall,
  TOOL_FENCE_LANGUAGE,
  type ToolCall,
  type ToolResult,
} from "./tools";

/**
 * Multi-step tool loop layered on top of fetchAIResponse rather than replacing
 * it. Each pass is an ordinary completion; when the model emits a tool block the
 * stream is cut short, the tool runs, and its result is appended as the next
 * turn.
 *
 * Multi-step is opt-in per request. Four round trips for "what is the capital of
 * France" would destroy the point of an instant HUD, so a single pass with no
 * tool block behaves exactly like a normal completion.
 */

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall; iteration: number }
  | { type: "tool_result"; result: ToolResult; iteration: number }
  | { type: "notice"; message: string };

type FetchAIResponse = (params: {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: { provider: string; variables: Record<string, string> };
  systemPrompt?: string;
  history?: Message[];
  userMessage: string;
  imagesBase64?: string[];
  codeIntent?: boolean;
  signal?: AbortSignal;
}) => AsyncIterable<string>;

export interface AgentLoopParams {
  fetchAIResponse: FetchAIResponse;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: { provider: string; variables: Record<string, string> };
  systemPrompt?: string;
  history?: Message[];
  userMessage: string;
  imagesBase64?: string[];
  codeIntent?: boolean;
  signal?: AbortSignal;
  toolNames: string[];
  /** Upper bound on model round trips, including the final answer. */
  maxIterations?: number;
}

export const DEFAULT_MAX_ITERATIONS = 6;

/** Two malformed blocks in a row means the model cannot drive the protocol. */
const MALFORMED_LIMIT = 2;

const FENCE_MARKER = "```" + TOOL_FENCE_LANGUAGE;

/**
 * How much of the buffer is safe to show the user.
 *
 * A stream arrives in fragments, so the buffer passes through every prefix of
 * the fence marker before matching it. Emitting eagerly leaks "```omni:too" as
 * prose, so any trailing prefix of the marker is held back until the next
 * fragment proves it was not a fence after all.
 */
const safeEmitLength = (buffer: string): number => {
  const fenceIndex = buffer.indexOf(FENCE_MARKER);
  if (fenceIndex !== -1) return fenceIndex;

  const longestPossible = Math.min(FENCE_MARKER.length - 1, buffer.length);
  for (let length = longestPossible; length > 0; length--) {
    if (buffer.endsWith(FENCE_MARKER.slice(0, length))) {
      return buffer.length - length;
    }
  }
  return buffer.length;
};

const withToolInstructions = (
  systemPrompt: string | undefined,
  toolNames: string[]
): string | undefined => {
  const instructions = buildToolInstructions(toolNames);
  if (!instructions) return systemPrompt;
  return systemPrompt ? `${systemPrompt}\n\n${instructions}` : instructions;
};

export async function* runAgentLoop(
  params: AgentLoopParams
): AsyncIterable<AgentEvent> {
  const {
    fetchAIResponse,
    provider,
    selectedProvider,
    systemPrompt,
    history = [],
    userMessage,
    imagesBase64 = [],
    codeIntent = false,
    signal,
    toolNames,
    maxIterations = DEFAULT_MAX_ITERATIONS,
  } = params;

  const conversation: Message[] = [...history];
  let currentMessage = userMessage;
  let currentImages = imagesBase64;
  let malformedBlocks = 0;
  let toolsEnabled = toolNames.length > 0;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (signal?.aborted) return;

    // Aborting this pass is how a tool block cuts the stream short without
    // waiting for the model to finish talking.
    const passController = new AbortController();
    const onOuterAbort = () => passController.abort();
    signal?.addEventListener("abort", onOuterAbort, { once: true });

    let buffer = "";
    let emitted = 0;
    let pendingCall: ToolCall | null = null;

    try {
      for await (const delta of fetchAIResponse({
        provider,
        selectedProvider,
        systemPrompt: toolsEnabled
          ? withToolInstructions(systemPrompt, toolNames)
          : systemPrompt,
        history: conversation,
        userMessage: currentMessage,
        imagesBase64: currentImages,
        codeIntent,
        signal: passController.signal,
      })) {
        buffer += delta;

        if (!toolsEnabled) {
          yield { type: "text", delta };
          emitted = buffer.length;
          continue;
        }

        const parsed = parseToolCall(buffer);
        if (parsed) {
          pendingCall = parsed.call;
          passController.abort();
          break;
        }

        const safeLength = safeEmitLength(buffer);
        if (safeLength > emitted) {
          yield { type: "text", delta: buffer.slice(emitted, safeLength) };
          emitted = safeLength;
        }
      }
    } finally {
      signal?.removeEventListener("abort", onOuterAbort);
    }

    if (signal?.aborted) return;

    if (!pendingCall) {
      // A fence that opened but never closed is a malformed attempt, not an
      // answer, so the held-back text must still be released.
      if (buffer.length > emitted) {
        yield { type: "text", delta: buffer.slice(emitted) };
      }
      return;
    }

    if (iteration === maxIterations) {
      yield {
        type: "notice",
        message: `Stopped after ${maxIterations} steps without a final answer.`,
      };
      return;
    }

    yield { type: "tool_call", call: pendingCall, iteration };
    const result = await runToolCall(pendingCall);
    yield { type: "tool_result", result, iteration };

    if (!result.ok && result.content.startsWith("No tool named")) {
      malformedBlocks++;
      if (malformedBlocks >= MALFORMED_LIMIT) {
        toolsEnabled = false;
        yield {
          type: "notice",
          message: "Answering without tools: the model could not use them.",
        };
      }
    }

    // Both sides of this exchange move into history before the tool result
    // becomes the next turn. Pushing only the assistant reply would drop the
    // question itself, leaving the model asked to "answer the original request"
    // with no original request anywhere in its context.
    conversation.push({ role: "user", content: currentMessage } as Message);
    conversation.push({ role: "assistant", content: buffer } as Message);

    // Images belong to the original question; resending them every pass wastes
    // the budget for no gain.
    currentMessage = renderToolResult(result);
    currentImages = [];
  }
}

/**
 * The loop rendered as plain text, so a caller that already consumes a stream of
 * strings needs no restructuring. Tool activity is surfaced as it happens: a
 * multi-step answer takes seconds, and silence reads as a hang.
 */
export async function* runAgentLoopAsText(
  params: AgentLoopParams
): AsyncIterable<string> {
  for await (const event of runAgentLoop(params)) {
    switch (event.type) {
      case "text":
        yield event.delta;
        break;
      case "tool_call":
        yield `\n\n> Step ${event.iteration}: using \`${event.call.name}\`\n\n`;
        break;
      case "tool_result":
        if (!event.result.ok) {
          yield `> \`${event.result.name}\` failed: ${event.result.content}\n\n`;
        }
        break;
      case "notice":
        yield `\n\n> ${event.message}\n\n`;
        break;
    }
  }
}
