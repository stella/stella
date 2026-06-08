import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { SafeDb, Transaction } from "@/api/db";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  createChatHistoryTools,
  EXPAND_CHAT_HISTORY_TOOL_NAME,
  SEARCH_CHAT_HISTORY_TOOL_NAME,
} from "./chat-history-tools";

const threadId = toSafeId<"chatThread">("11111111-1111-4111-8111-111111111111");
const hiddenMessageId = toSafeId<"chatMessage">(
  "22222222-2222-4222-8222-222222222222",
);

const createSafeDbCapture = () => {
  const queries: SQL[] = [];
  const tx = {
    execute: async (query: SQL) => {
      queries.push(query);
      return [];
    },
  };
  const safeDb: SafeDb = async (callback) =>
    Result.ok(await callback(asTestRaw<Transaction>(tx)));

  return { queries, safeDb };
};

describe("chat history tools", () => {
  test("exclude replay-truncated messages from history search", async () => {
    const { queries, safeDb } = createSafeDbCapture();
    const tools = createChatHistoryTools({
      excludedMessageIds: [hiddenMessageId],
      safeDb,
      threadId,
    });
    const searchTool = tools[SEARCH_CHAT_HISTORY_TOOL_NAME];

    await searchTool.execute?.(
      { limit: 3, query: "old branch" },
      asTestRaw<Parameters<NonNullable<typeof searchTool.execute>>[1]>({}),
    );

    const query = queries.at(0);
    expect(query).toBeDefined();
    if (!query) {
      return;
    }

    const compiled = new PgDialect().sqlToQuery(query);
    expect(compiled.sql).toContain("message_id NOT IN");
    expect(compiled.params).toContain(hiddenMessageId);
  });

  test("does not expand a replay-truncated target message", async () => {
    const { queries, safeDb } = createSafeDbCapture();
    const tools = createChatHistoryTools({
      excludedMessageIds: [hiddenMessageId],
      safeDb,
      threadId,
    });
    const expandTool = tools[EXPAND_CHAT_HISTORY_TOOL_NAME];

    const result = await expandTool.execute?.(
      { after: 2, before: 2, messageId: hiddenMessageId },
      asTestRaw<Parameters<NonNullable<typeof expandTool.execute>>[1]>({}),
    );

    expect(result).toEqual({
      targetMessageId: hiddenMessageId,
      messages: [],
    });
    expect(queries).toHaveLength(0);
  });
});
