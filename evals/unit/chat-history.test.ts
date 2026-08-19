// Covers the persistence boundary that dropped attached images: the hook is
// what discarded them, but nothing proved the DB layer round-trips them, so
// the fix was shipped on inspection alone. These tests exercise the real
// createConversation and getConversationById against a stubbed plugin-sql.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSrcModule } from "../harness/loadSrcModule.ts";
import {
  recorded,
  reset,
  setSelectHandler,
  statementsMatching,
} from "./stubs/plugin-sql.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

interface AttachedFile {
  id: string;
  name: string;
  type: string;
  base64: string;
  size: number;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  attachedFiles?: AttachedFile[];
}

interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

interface ChatHistoryModule {
  createConversation: (c: ChatConversation) => Promise<ChatConversation>;
  getConversationById: (id: string) => Promise<ChatConversation | null>;
}

const { createConversation, getConversationById } =
  await loadSrcModule<ChatHistoryModule>("lib/database/chat-history.action.ts", {
    alias: {
      "@tauri-apps/plugin-sql": join(HERE, "stubs", "plugin-sql.ts"),
    },
  });

const screenshot: AttachedFile = {
  id: "file_1",
  name: "screenshot.png",
  type: "image/png",
  base64: "aGVsbG8=",
  size: 1234,
};

const conversationWith = (files?: AttachedFile[]): ChatConversation => ({
  id: "conv_1700000000000_abcdefghi",
  title: "a conversation",
  messages: [
    {
      id: "msg_1700000000000_user",
      role: "user",
      content: "what is in this screenshot",
      timestamp: 1700000000000,
      attachedFiles: files,
    },
    {
      id: "msg_1700000000001_assistant",
      role: "assistant",
      content: "a terminal window",
      timestamp: 1700000000001,
    },
  ],
  createdAt: 1700000000000,
  updatedAt: 1700000000001,
});

beforeEach(() => reset());

test("an attached image is serialized into the message insert", async () => {
  await createConversation(conversationWith([screenshot]));

  const inserts = statementsMatching("INSERT INTO messages", "attached_files");
  assert.equal(inserts.length, 2, "expected one insert per message");

  const userInsert = inserts.find((s) =>
    s.params.includes("what is in this screenshot")
  );
  assert.ok(userInsert, "user message was not inserted");

  const stored = userInsert.params[userInsert.params.length - 1];
  assert.equal(typeof stored, "string", "attached_files should be JSON text");
  assert.deepEqual(JSON.parse(stored as string), [screenshot]);
});

test("a message with no attachments stores null, not the string 'undefined'", async () => {
  await createConversation(conversationWith(undefined));

  const inserts = statementsMatching("INSERT INTO messages", "attached_files");
  for (const insert of inserts) {
    assert.equal(insert.params[insert.params.length - 1], null);
  }
});

test("attached files come back out on read", async () => {
  setSelectHandler((sql) => {
    if (sql.includes("FROM conversations")) {
      return [
        {
          id: "conv_1700000000000_abcdefghi",
          title: "a conversation",
          created_at: 1700000000000,
          updated_at: 1700000000001,
        },
      ];
    }
    if (sql.includes("FROM messages")) {
      return [
        {
          id: "msg_1700000000000_user",
          conversation_id: "conv_1700000000000_abcdefghi",
          role: "user",
          content: "what is in this screenshot",
          timestamp: 1700000000000,
          attached_files: JSON.stringify([screenshot]),
        },
      ];
    }
    return [];
  });

  const loaded = await getConversationById("conv_1700000000000_abcdefghi");
  assert.ok(loaded, "conversation should be found");
  assert.deepEqual(loaded.messages[0]?.attachedFiles, [screenshot]);
});

test("malformed attached_files does not take the whole conversation down", async () => {
  setSelectHandler((sql) => {
    if (sql.includes("FROM conversations")) {
      return [
        {
          id: "conv_1700000000000_abcdefghi",
          title: "a conversation",
          created_at: 1700000000000,
          updated_at: 1700000000001,
        },
      ];
    }
    if (sql.includes("FROM messages")) {
      return [
        {
          id: "msg_1700000000000_user",
          conversation_id: "conv_1700000000000_abcdefghi",
          role: "user",
          content: "still readable",
          timestamp: 1700000000000,
          attached_files: "{not json",
        },
      ];
    }
    return [];
  });

  const loaded = await getConversationById("conv_1700000000000_abcdefghi");
  assert.ok(loaded, "conversation should still load");
  assert.equal(loaded.messages[0]?.content, "still readable");
  assert.equal(loaded.messages[0]?.attachedFiles, undefined);
});

test("every message insert passes exactly six bound parameters", async () => {
  await createConversation(conversationWith([screenshot]));
  for (const insert of statementsMatching("INSERT INTO messages")) {
    assert.equal(
      insert.params.length,
      6,
      `column count and parameter count must agree: ${insert.sql}`
    );
  }
  assert.ok(recorded.length > 0);
});
