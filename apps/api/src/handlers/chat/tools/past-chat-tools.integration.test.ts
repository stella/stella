import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createChatHistoryTools } from "@/api/handlers/chat/tools/chat-history-tools";
import {
  createPastChatTools,
  PAST_CHAT_SCOPE_TYPE,
  SEARCH_ALL_PAST_CHATS_TOOL_NAME,
  SEARCH_PAST_CHATS_TOOL_NAME,
} from "@/api/handlers/chat/tools/past-chat-tools";
import type { PastChatScope } from "@/api/handlers/chat/tools/past-chat-tools";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Runs the past-chat search against PGlite under the caller's RLS scope. Every
// seeded thread mentions the same term, so what a search returns is decided
// only by ownership, the current thread, and the past-chat scope.

const TERM = "escrowclause";

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

type SeedThreadArgs = {
  dataWorkspaceIds?: SafeId<"workspace">[];
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

const seedThread = async ({
  dataWorkspaceIds = [],
  userId,
  workspaceId,
}: SeedThreadArgs) => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  const messageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  const text = `We agreed on the ${TERM} wording.`;
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    userId,
    title: "Past chat",
    workspaceId,
    dataWorkspaceIds,
  });
  seededThreadIds.push(threadId);
  await testDb.insert(chatMessages).values({
    id: messageId,
    threadId,
    userId,
    workspaceId,
    role: "user",
    content: { version: 1, data: [{ type: "text", text }] },
    createdAt: new Date(),
  });
  await testDb.execute(sql`
    INSERT INTO chat_message_search_documents (
      message_id, thread_id, role, searchable_text, tsv, created_at
    ) VALUES (
      ${messageId}, ${threadId}, 'user', ${text},
      to_tsvector('simple', unaccent(arabic_normalize(${text}))),
      now()
    )
  `);
  return { messageId, threadId };
};

let current: Awaited<ReturnType<typeof seedThread>>;
let sameMatter: Awaited<ReturnType<typeof seedThread>>;
let otherMatter: Awaited<ReturnType<typeof seedThread>>;
let globalAboutMatter: Awaited<ReturnType<typeof seedThread>>;
let globalPlain: Awaited<ReturnType<typeof seedThread>>;
let otherUser: Awaited<ReturnType<typeof seedThread>>;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  const scoped = createScopedDb(
    testDb,
    [ids.wsA1, ids.wsA2],
    ids.orgA,
    ids.userA1,
  );
  // Production's Bun SQL driver resolves `execute` to the rows themselves with
  // `timestamptz` as `Date`; drizzle's PGlite driver resolves to `{ rows }`
  // with timestamps as strings. Present the production shape.
  const scopedRows = asTestRaw<ScopedDb>(
    async (run: (tx: unknown) => Promise<unknown>) =>
      await scoped(
        async (tx) =>
          await run({
            execute: async (query: SQL) =>
              (await tx.execute(query)).rows.map((row) =>
                typeof row === "object" &&
                row !== null &&
                "createdAt" in row &&
                typeof row.createdAt === "string"
                  ? Object.assign(row, { createdAt: new Date(row.createdAt) })
                  : row,
              ),
          }),
      ),
  );
  safeDb = toSafeDbMock(scopedRows);

  current = await seedThread({ userId: ids.userA1, workspaceId: ids.wsA1 });
  sameMatter = await seedThread({ userId: ids.userA1, workspaceId: ids.wsA1 });
  otherMatter = await seedThread({
    userId: ids.userA1,
    workspaceId: ids.wsA2,
    dataWorkspaceIds: [ids.wsA2],
  });
  globalAboutMatter = await seedThread({
    userId: ids.userA1,
    workspaceId: null,
    dataWorkspaceIds: [ids.wsA1],
  });
  globalPlain = await seedThread({ userId: ids.userA1, workspaceId: null });
  otherUser = await seedThread({ userId: ids.userA2, workspaceId: ids.wsA2 });
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

const toolsFor = (scope: PastChatScope) => {
  const refRegistry = createChatRefRegistry();
  const tools = createPastChatTools({
    organizationId: ids.orgA,
    refRegistry,
    safeDb,
    scope,
    threadId: current.threadId,
    userId: ids.userA1,
  });
  return { refRegistry, tools };
};

const runSearch = async (
  tool: ReturnType<
    typeof toolsFor
  >["tools"][typeof SEARCH_PAST_CHATS_TOOL_NAME],
) => {
  const output = await tool.execute?.(
    { query: TERM, limit: 10 },
    asTestRaw<Parameters<NonNullable<typeof tool.execute>>[1]>({}),
  );
  return new Set(output?.results.map((result) => result.threadId));
};

describe("past-chat search", () => {
  test("a matter-scoped search reads only chats about that matter", async () => {
    const { tools } = toolsFor({
      type: PAST_CHAT_SCOPE_TYPE.matters,
      workspaceIds: [ids.wsA1],
    });

    const found = await runSearch(tools[SEARCH_PAST_CHATS_TOOL_NAME]);

    expect(found).toEqual(
      new Set([sameMatter.threadId, globalAboutMatter.threadId]),
    );
  });

  test("the widened search reads every own chat except the current one", async () => {
    const { refRegistry, tools } = toolsFor({
      type: PAST_CHAT_SCOPE_TYPE.matters,
      workspaceIds: [ids.wsA1],
    });

    const found = await runSearch(tools[SEARCH_ALL_PAST_CHATS_TOOL_NAME]);

    expect(found).toEqual(
      new Set([
        sameMatter.threadId,
        otherMatter.threadId,
        globalAboutMatter.threadId,
        globalPlain.threadId,
      ]),
    );
    expect(found.has(otherUser.threadId)).toBe(false);
    // The other matter's content now sits in this turn, so it must fold into
    // the thread's data scope.
    expect(refRegistry.getRegisteredWorkspaceIds()).toContain(ids.wsA2);
  });

  test("expanding another chat's message reads its thread and registers its matter", async () => {
    const refRegistry = createChatRefRegistry();
    const expandTool = createChatHistoryTools({
      organizationId: ids.orgA,
      refRegistry,
      safeDb,
      threadId: current.threadId,
      userId: ids.userA1,
    })["expand-chat-history"];

    const output = await expandTool.execute?.(
      { messageId: otherMatter.messageId, before: 2, after: 2 },
      asTestRaw<Parameters<NonNullable<typeof expandTool.execute>>[1]>({}),
    );

    expect(output?.messages.map((message) => message.messageId)).toEqual([
      otherMatter.messageId,
    ]);
    expect(refRegistry.getRegisteredWorkspaceIds()).toContain(ids.wsA2);
  });

  test("expanding another user's message returns nothing", async () => {
    const expandTool = createChatHistoryTools({
      organizationId: ids.orgA,
      refRegistry: createChatRefRegistry(),
      safeDb,
      threadId: current.threadId,
      userId: ids.userA1,
    })["expand-chat-history"];

    const output = await expandTool.execute?.(
      { messageId: otherUser.messageId, before: 2, after: 2 },
      asTestRaw<Parameters<NonNullable<typeof expandTool.execute>>[1]>({}),
    );

    expect(output?.messages).toEqual([]);
  });
});
