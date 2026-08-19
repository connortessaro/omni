// Runs the real tool loop against a live provider, so the text protocol is
// checked against an actual model rather than only against scripted stubs.
//
// The prompt asks for a repository's numeric id: stable enough to verify
// independently, and opaque enough that no model could answer from memory. A
// matching answer is proof the tool ran and its result reached the next pass.
//
//   set -a; . ~/.config/omni/eval.env; set +a
//   node scripts/verify-agent-loop.mjs
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSrcModule } from "../evals/harness/loadSrcModule.ts";
import { resolveProviderFromEnv } from "../evals/harness/providerConfig.ts";
import { installMemoryLocalStorage } from "../evals/harness/fakeGlobals.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = "https://api.github.com/repos/connortessaro/omni";

installMemoryLocalStorage({
  response_settings: JSON.stringify({
    responseLength: "auto",
    language: "english",
    autoScroll: true,
  }),
});

// Fetch the truth first, so the check does not depend on trusting the model.
let expectedId;
try {
  const probe = await fetch(TARGET, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!probe.ok) throw new Error(`probe returned ${probe.status}`);
  expectedId = String((await probe.json()).id);
} catch (error) {
  console.error(
    `Cannot verify: ${TARGET} is unreachable (${error instanceof Error ? error.message : error}).`
  );
  console.error("This is an environment problem, not a loop failure.");
  process.exit(1);
}

const { provider, selectedProvider } = await resolveProviderFromEnv();

// Only the tool transport is swapped; the loop, protocol, and prompt are real.
const { runAgentLoop } = await loadSrcModule("lib/agent/loop.ts", {
  alias: { "@tauri-apps/plugin-http": join(HERE, "node-http-passthrough.mjs") },
});
const { fetchAIResponse } = await loadSrcModule(
  "lib/functions/ai-response.function.ts"
);

console.log(`Provider: ${provider.id} / ${selectedProvider.variables.model}`);
console.log(`Expecting id ${expectedId}, which no model could know.\n`);

let answer = "";
let toolCalls = 0;

for await (const event of runAgentLoop({
  fetchAIResponse,
  provider,
  selectedProvider,
  userMessage: `Fetch ${TARGET} and tell me the value of its top-level "id" field. Reply with just that number.`,
  toolNames: ["fetch_url"],
  maxIterations: 4,
})) {
  if (event.type === "tool_call") {
    toolCalls++;
    console.log(
      `step ${event.iteration}: ${event.call.name} ${JSON.stringify(event.call.args)}`
    );
  }
  if (event.type === "tool_result") {
    const preview = event.result.content.replace(/\s+/g, " ").slice(0, 100);
    console.log(`  -> ${event.result.ok ? "ok" : "FAILED"}: ${preview}`);
  }
  if (event.type === "notice") console.log(`notice: ${event.message}`);
  if (event.type === "text") answer += event.delta;
}

console.log(`\nanswer: ${answer.trim()}`);

const failures = [];
if (toolCalls === 0) failures.push("the model never called a tool");
if (!answer.includes(expectedId)) {
  failures.push(`the answer does not contain the real id ${expectedId}`);
}
if (/omni:tool|```/.test(answer)) {
  failures.push("protocol text leaked into the answer");
}

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log(
    `\nPASS: ${toolCalls} tool call(s), the answer carries the real id, and no protocol text leaked.`
  );
}
