import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";

import type { ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { readChatThreadNames } from "@/api/lib/chat/thread-names";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
let scoped: ScopedDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scoped = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  );
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

describe("a thread's names derived from its stored messages", () => {
  test("hold the ids of stored tool calls", async () => {
    const base = Date.parse("2026-02-21T00:00:00.000Z");
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    await testDb.insert(chatThreads).values({
      id: threadId,
      organizationId: ids.orgA,
      userId: ids.userA1,
      title: "Thread names test thread",
      workspaceId: ids.wsA1,
    });
    seededThreadIds.push(threadId);
    const row = (index: number) => ({
      createdAt: new Date(base + index),
      id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
      role: "assistant" as const,
      threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    });
    await testDb.insert(chatMessages).values([
      {
        ...row(0),
        content: toPersistedChatMessageContentV3({
          data: [
            {
              type: "tool-call",
              id: "call_0",
              name: "mcp__external__lookup",
              arguments: "{}",
              state: "input-complete",
              metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
            },
          ],
        }),
      },
    ]);

    const names = await scoped(
      async (tx) => await readChatThreadNames({ threadId, tx }),
    );

    expect(names.source).toBe("messages");
    expect(new Set(names.toolCallIds)).toEqual(new Set(["call_0"]));
  });
});
