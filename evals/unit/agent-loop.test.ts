// Covers the tool loop with a scripted model, so the protocol handling is tested
// without spending API calls: fence detection mid-stream, withholding partial
// tool blocks from the user, tool dispatch, the iteration ceiling, abort, and
// degrading when the model cannot drive the protocol.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSrcModule } from "../harness/loadSrcModule.ts";
import { installMemoryLocalStorage } from "../harness/fakeGlobals.ts";
import {
  replyWith,
  requests as httpRequestLog,
  reset as resetHttp,
  setResponder,
} from "./stubs/plugin-http.ts";

const httpRequests = () => httpRequestLog;
import { reset as resetSql, setSelectHandler } from "./stubs/plugin-sql.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const stub = (name: string) => join(HERE, "stubs", `${name}.ts`);

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall; iteration: number }
  | { type: "tool_result"; result: { name: string; ok: boolean; content: string }; iteration: number }
  | { type: "notice"; message: string };

interface LoopModule {
  runAgentLoop: (params: Record<string, unknown>) => AsyncIterable<AgentEvent>;
  DEFAULT_MAX_ITERATIONS: number;
}

installMemoryLocalStorage();

const alias = {
  "@tauri-apps/plugin-http": stub("plugin-http"),
  "@tauri-apps/plugin-sql": stub("plugin-sql"),
};

const { runAgentLoop } = await loadSrcModule<LoopModule>("lib/agent/loop.ts", {
  alias,
});

/** A model that returns each scripted reply in turn, one character at a time. */
const scriptedModel = (replies: string[]) => {
  const prompts: { userMessage: string; systemPrompt?: string }[] = [];
  let call = 0;

  const fetchAIResponse = async function* (params: {
    userMessage: string;
    systemPrompt?: string;
    signal?: AbortSignal;
  }) {
    prompts.push({
      userMessage: params.userMessage,
      systemPrompt: params.systemPrompt,
    });
    const reply = replies[Math.min(call, replies.length - 1)] ?? "";
    call++;
    for (const char of reply) {
      if (params.signal?.aborted) return;
      yield char;
    }
  };

  return { fetchAIResponse, prompts, callCount: () => call };
};

const toolBlock = (name: string, args: Record<string, unknown>) =>
  "```omni:tool\n" + JSON.stringify({ name, args }) + "\n```";

const collect = async (events: AsyncIterable<AgentEvent>) => {
  const all: AgentEvent[] = [];
  for await (const event of events) all.push(event);
  return {
    all,
    text: all
      .filter((e): e is { type: "text"; delta: string } => e.type === "text")
      .map((e) => e.delta)
      .join(""),
    calls: all.filter((e) => e.type === "tool_call"),
    results: all.filter((e) => e.type === "tool_result"),
    notices: all.filter((e) => e.type === "notice"),
  };
};

const baseParams = {
  provider: { id: "test", curl: "", responseContentPath: "", streaming: true },
  selectedProvider: { provider: "test", variables: {} },
  userMessage: "the original question",
  toolNames: ["fetch_url", "search_chat_history"],
};

beforeEach(() => {
  resetHttp();
  resetSql();
});

test("a plain answer streams straight through with no extra round trip", async () => {
  const model = scriptedModel(["the capital of France is Paris"]);
  const out = await collect(
    runAgentLoop({ ...baseParams, fetchAIResponse: model.fetchAIResponse })
  );

  assert.equal(out.text, "the capital of France is Paris");
  assert.equal(out.calls.length, 0);
  assert.equal(model.callCount(), 1, "a question needing no tool must cost one call");
});

test("tool instructions are appended to the system prompt", async () => {
  const model = scriptedModel(["done"]);
  await collect(
    runAgentLoop({
      ...baseParams,
      systemPrompt: "You are Omni.",
      fetchAIResponse: model.fetchAIResponse,
    })
  );

  const sent = model.prompts[0]?.systemPrompt ?? "";
  assert.match(sent, /^You are Omni\./);
  assert.match(sent, /omni:tool/);
  assert.match(sent, /fetch_url/);
  assert.match(sent, /search_chat_history/);
});

test("a tool call runs and its result drives a second pass", async () => {
  replyWith("the page says the answer is 42");
  const model = scriptedModel([
    toolBlock("fetch_url", { url: "https://example.com/docs" }),
    "the answer is 42",
  ]);

  const out = await collect(
    runAgentLoop({ ...baseParams, fetchAIResponse: model.fetchAIResponse })
  );

  assert.equal(out.calls.length, 1);
  assert.deepEqual(out.calls[0]?.call.args, { url: "https://example.com/docs" });
  assert.equal(out.results[0]?.result.ok, true);
  assert.equal(out.text, "the answer is 42");
  assert.equal(model.callCount(), 2);
  assert.match(
    model.prompts[1]?.userMessage ?? "",
    /Result of fetch_url \(ok\)/,
    "the tool result should become the next user turn"
  );
});

test("the original question survives into the pass after a tool call", async () => {
  // Without this the model is told to answer a request it can no longer see.
  replyWith("page text");
  const model = scriptedModel([
    toolBlock("fetch_url", { url: "https://example.com" }),
    "answered",
  ]);
  const histories: unknown[] = [];
  const wrapped = async function* (params: Record<string, unknown>) {
    histories.push(params.history);
    yield* model.fetchAIResponse(params as never);
  };

  await collect(
    runAgentLoop({ ...baseParams, fetchAIResponse: wrapped as never })
  );

  const secondPassHistory = histories[1] as { role: string; content: string }[];
  assert.ok(
    secondPassHistory.some(
      (m) => m.role === "user" && m.content === "the original question"
    ),
    "the original user question must be in the second pass history"
  );
  assert.ok(
    secondPassHistory.some((m) => m.role === "assistant"),
    "the assistant turn that called the tool must be there too"
  );
});

test("a partial tool block never leaks to the user as prose", async () => {
  replyWith("page text");
  const model = scriptedModel([
    "Let me check. " + toolBlock("fetch_url", { url: "https://example.com" }),
    "checked",
  ]);

  const out = await collect(
    runAgentLoop({ ...baseParams, fetchAIResponse: model.fetchAIResponse })
  );

  assert.ok(!out.text.includes("omni:tool"), "the fence must not reach the user");
  assert.ok(!out.text.includes("```"), "no stray fence markers");
  assert.match(out.text, /^Let me check\. /, "prose before the block still shows");
});

test("an unclosed fence is released rather than swallowed", async () => {
  // Truncated mid-block: withheld text must still surface, or the turn looks empty.
  const model = scriptedModel(["Thinking. ```omni:tool\n{\"name\":\"fetch_ur"]);
  const out = await collect(
    runAgentLoop({ ...baseParams, fetchAIResponse: model.fetchAIResponse })
  );

  assert.match(out.text, /Thinking\./);
  assert.equal(out.calls.length, 0);
});

test("an unknown tool is reported back to the model, not thrown", async () => {
  const model = scriptedModel([
    toolBlock("teleport", {}),
    "sorry, answering directly",
  ]);
  const out = await collect(
    runAgentLoop({ ...baseParams, fetchAIResponse: model.fetchAIResponse })
  );

  assert.equal(out.results[0]?.result.ok, false);
  assert.match(out.results[0]?.result.content ?? "", /No tool named "teleport"/);
  assert.equal(out.text, "sorry, answering directly");
});

test("repeated unusable tool calls fall back to answering without tools", async () => {
  const model = scriptedModel([
    toolBlock("nope", {}),
    toolBlock("still_nope", {}),
    "fine, here is the answer",
  ]);
  const out = await collect(
    runAgentLoop({ ...baseParams, fetchAIResponse: model.fetchAIResponse })
  );

  assert.equal(out.notices.length, 1);
  assert.match(out.notices[0]?.message ?? "", /without tools/);
  assert.equal(out.text, "fine, here is the answer");
  const lastPrompt = model.prompts[model.prompts.length - 1];
  assert.ok(
    !/omni:tool/.test(lastPrompt?.systemPrompt ?? ""),
    "the final pass should not advertise tools"
  );
});

test("the iteration ceiling stops a model that only ever calls tools", async () => {
  replyWith("more page text");
  const model = scriptedModel([toolBlock("fetch_url", { url: "https://example.com" })]);

  const out = await collect(
    runAgentLoop({
      ...baseParams,
      fetchAIResponse: model.fetchAIResponse,
      maxIterations: 3,
    })
  );

  assert.equal(model.callCount(), 3);
  assert.equal(out.notices.length, 1);
  assert.match(out.notices[0]?.message ?? "", /Stopped after 3 steps/);
});

test("an outer abort ends the loop without running another tool", async () => {
  replyWith("page");
  const controller = new AbortController();
  const model = scriptedModel([
    toolBlock("fetch_url", { url: "https://example.com" }),
    "second pass",
  ]);

  const events: AgentEvent[] = [];
  for await (const event of runAgentLoop({
    ...baseParams,
    fetchAIResponse: model.fetchAIResponse,
    signal: controller.signal,
  })) {
    events.push(event);
    if (event.type === "tool_result") controller.abort();
  }

  assert.ok(events.some((e) => e.type === "tool_result"));
  assert.ok(
    !events.some((e) => e.type === "text" && e.delta.includes("second pass")),
    "no further text after abort"
  );
});

test("search_chat_history reads real conversations through the database layer", async () => {
  setSelectHandler((sql) => {
    if (sql.includes("FROM conversations")) {
      return [
        {
          id: "conv_1",
          title: "Postgres work",
          created_at: 1,
          updated_at: 2,
        },
      ];
    }
    if (sql.includes("FROM messages")) {
      return [
        {
          id: "msg_1",
          conversation_id: "conv_1",
          role: "user",
          content: "how do I run the postgres migration safely",
          timestamp: 1,
          attached_files: null,
        },
      ];
    }
    return [];
  });

  const model = scriptedModel([
    toolBlock("search_chat_history", { query: "postgres migration" }),
    "you asked about it earlier",
  ]);
  const out = await collect(
    runAgentLoop({ ...baseParams, fetchAIResponse: model.fetchAIResponse })
  );

  assert.equal(out.results[0]?.result.ok, true);
  assert.match(out.results[0]?.result.content ?? "", /Postgres work/);
  assert.match(out.results[0]?.result.content ?? "", /migration safely/);
});

test("a redirect into a private address is refused, not followed", async () => {
  // The block list only ever sees the first URL if the client follows redirects
  // itself, so a public host can bounce the request to a metadata endpoint.
  const attacks = [
    { from: "https://evil.example/go", to: "http://169.254.169.254/latest/meta-data/" },
    { from: "https://evil.example/go", to: "http://127.0.0.1:8080/admin" },
    { from: "https://evil.example/go", to: "http://10.0.0.1/" },
  ];

  for (const attack of attacks) {
    resetHttp();
    setResponder((url) => {
      if (url === attack.from) {
        return { status: 302, body: "", headers: { location: attack.to } };
      }
      return { status: 200, body: "SECRET CREDENTIALS" };
    });

    const model = scriptedModel([
      toolBlock("fetch_url", { url: attack.from }),
      "done",
    ]);
    const out = await collect(
      runAgentLoop({ ...baseParams, fetchAIResponse: model.fetchAIResponse })
    );

    assert.equal(out.results[0]?.result.ok, false, `${attack.to} should be refused`);
    assert.match(
      out.results[0]?.result.content ?? "",
      /Cannot follow redirect/,
      `${attack.to} should be refused as a redirect`
    );
    assert.ok(
      !httpRequests().some((request) => request.url === attack.to),
      `${attack.to} must never actually be requested`
    );
  }
});

test("a redirect to another public address is followed", async () => {
  setResponder((url) => {
    if (url === "https://example.com/old") {
      return { status: 301, body: "", headers: { location: "/new" } };
    }
    return { status: 200, body: "the moved content" };
  });

  const model = scriptedModel([
    toolBlock("fetch_url", { url: "https://example.com/old" }),
    "read it",
  ]);
  const out = await collect(
    runAgentLoop({ ...baseParams, fetchAIResponse: model.fetchAIResponse })
  );

  assert.equal(out.results[0]?.result.ok, true);
  assert.match(out.results[0]?.result.content ?? "", /the moved content/);
  assert.ok(
    httpRequests().some((r) => r.url === "https://example.com/new"),
    "a relative location should resolve against the current url"
  );
});

test("a redirect loop gives up instead of spinning", async () => {
  setResponder(() => ({
    status: 302,
    body: "",
    headers: { location: "https://example.com/loop" },
  }));

  const model = scriptedModel([
    toolBlock("fetch_url", { url: "https://example.com/loop" }),
    "done",
  ]);
  const out = await collect(
    runAgentLoop({ ...baseParams, fetchAIResponse: model.fetchAIResponse })
  );

  assert.equal(out.results[0]?.result.ok, false);
  assert.match(out.results[0]?.result.content ?? "", /Gave up after \d+ redirects/);
});

test("a redirect with no location header is an error", async () => {
  setResponder(() => ({ status: 302, body: "" }));

  const model = scriptedModel([
    toolBlock("fetch_url", { url: "https://example.com/x" }),
    "done",
  ]);
  const out = await collect(
    runAgentLoop({ ...baseParams, fetchAIResponse: model.fetchAIResponse })
  );

  assert.equal(out.results[0]?.result.ok, false);
  assert.match(out.results[0]?.result.content ?? "", /without a location header/);
});

test("fetch_url refuses private and loopback addresses", async () => {
  const blocked = [
    "http://localhost:8080/admin",
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "file:///etc/passwd",
  ];

  for (const url of blocked) {
    const model = scriptedModel([toolBlock("fetch_url", { url }), "ok"]);
    const out = await collect(
      runAgentLoop({ ...baseParams, fetchAIResponse: model.fetchAIResponse })
    );
    assert.equal(out.results[0]?.result.ok, false, `${url} should be refused`);
    assert.match(
      out.results[0]?.result.content ?? "",
      /private or loopback|unsupported scheme/,
      `${url} should be refused for the right reason`
    );
  }
});
