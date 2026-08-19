import type { Task } from "../types.ts";
import {
  buildConfigFixture,
  buildLogFixture,
  buildSourceFixture,
  buildTranscriptFixture,
} from "./longContextFixtures.ts";

const config = buildConfigFixture();
const source = buildSourceFixture();
const log = buildLogFixture();
const transcript = buildTranscriptFixture();

// Two of these tasks paste the long document and ask the question in the same
// message (single-turn); the other two paste it as a prior turn and ask the
// question as a follow-up (history-splice), so both of buildDynamicMessages's
// code paths — templating the current message vs. spreading prior history —
// get exercised, not just one of them.
export const longContextTasks: Task[] = [
  {
    id: "long-context-config-value",
    category: "long-context",
    title: "Find one config value in a 300+ line config file (single-turn)",
    knownWeakness:
      "Known Omni weakness: needle facts placed in the middle of a long pasted document.",
    prompt:
      `Here is a service configuration file (${config.lineCount} lines):\n\n` +
      "```\n" +
      config.text +
      "\n```\n\n" +
      "What is the value of MAX_RETRY_BACKOFF_MS in the config above? Answer with just the number.",
    grader: { type: "substring", expectedAll: ["8742"] },
  },
  {
    id: "long-context-log-error-line",
    category: "long-context",
    title: "Find the one ERROR line in a 300+ line log (single-turn)",
    knownWeakness:
      "Known Omni weakness: needle facts placed in the middle of a long pasted document.",
    prompt:
      `Here is a service log (${log.lineCount} lines, one line per request):\n\n` +
      "```\n" +
      log.text +
      "\n```\n\n" +
      "Find the only ERROR line in the log above. What HTTP status code and which endpoint does it report?",
    grader: { type: "substring", expectedAll: ["503", "/api/v2/inventory/sync"] },
  },
  {
    id: "long-context-source-function-return",
    category: "long-context",
    title: "Trace a function buried in a 300+ line source file (history-splice)",
    knownWeakness:
      "Known Omni weakness: needle facts placed in the middle of a long pasted document, " +
      "compounded here by requiring the file to survive into a follow-up turn via history.",
    history: [
      {
        role: "user",
        content:
          `Here is a source file from our pricing service (${source.lineCount} lines). ` +
          "I'll ask you questions about it, don't summarize it yet:\n\n```javascript\n" +
          source.text +
          "\n```",
      },
      {
        role: "assistant",
        content: "Got it, I have the file loaded. Go ahead and ask your question.",
      },
    ],
    prompt: 'What does the function computeShippingSurcharge return when regionCode is "NW-7"?',
    grader: { type: "substring", expectedAll: ["42.75"] },
  },
  {
    id: "long-context-transcript-detail",
    category: "long-context",
    title: "Recall one buried detail from a 300+ line transcript (history-splice)",
    knownWeakness:
      "Known Omni weakness: needle facts placed in the middle of a long pasted document, " +
      "compounded here by requiring the file to survive into a follow-up turn via history.",
    history: [
      {
        role: "user",
        content:
          `Here is the transcript from today's migration planning sync (${transcript.lineCount} lines):\n\n` +
          "```\n" +
          transcript.text +
          "\n```",
      },
      {
        role: "assistant",
        content: "Thanks, I've read through the transcript. What would you like to know?",
      },
    ],
    prompt: "How many additional servers did Priya request, and by when does she need them?",
    grader: { type: "substring", expectedAll: ["14", "Friday"] },
  },
];
