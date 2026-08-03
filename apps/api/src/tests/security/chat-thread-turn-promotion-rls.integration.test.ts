import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type {
  TestDatabase,
  createScopedQuery,
} from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
let scopedQuery: ReturnType<typeof createScopedQuery>;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedQuery = fixture.scopedQuery;
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

const seedTurnBackedThread = async ({
  workspaceId,
}: {
  workspaceId: SafeId<"workspace"> | null;
}) => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  const userMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  const assistantMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  const turnId = toSafeId<"chatTurn">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);

  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Promotion RLS regression",
    userId: ids.userA1,
    workspaceId,
  });
  await testDb.insert(chatMessages).values([
    {
      content: { data: [{ text: "Draft", type: "text" }], version: 1 },
      id: userMessageId,
      role: "user",
      threadId,
      userId: ids.userA1,
      workspaceId,
    },
    {
      content: {
        data: [{ text: "Which jurisdiction?", type: "text" }],
        version: 1,
      },
      id: assistantMessageId,
      role: "assistant",
      threadId,
      userId: ids.userA1,
      workspaceId,
    },
  ]);
  await testDb.insert(chatTurns).values({
    assistantMessageId,
    id: turnId,
    interactionToolCallId: "ask-1",
    interactionType: "ask-user",
    organizationId: ids.orgA,
    status: "awaiting-user",
    threadId,
    userId: ids.userA1,
    userMessageId,
    workspaceId,
  });

  return { threadId, turnId };
};

const expectRlsDenied = async (operation: () => Promise<unknown>) => {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  expect(isPgError(caught, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
};

describe("chat thread workspace promotion RLS", () => {
  test("installs an owner-only workspace cascade trigger", async () => {
    const protection = await testDb.execute(sql<{
      securityDefiner: boolean;
      stellaCanExecute: boolean;
      triggerInstalled: boolean;
    }>`
      SELECT
        p.prosecdef AS "securityDefiner",
        has_function_privilege('stella', p.oid, 'EXECUTE') AS "stellaCanExecute",
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE t.tgname = 'chat_thread_workspace_cascade'
            AND n.nspname = 'public'
            AND c.relname = 'chat_threads'
            AND NOT t.tgisinternal
        ) AS "triggerInstalled"
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'sync_chat_turn_workspace_from_thread'
    `);
    expect(protection.rows).toEqual([
      {
        securityDefiner: true,
        stellaCanExecute: false,
        triggerInstalled: true,
      },
    ]);
  });

  test("moves a global draft and every durable turn into an authorized workspace", async () => {
    const { threadId, turnId } = await seedTurnBackedThread({
      workspaceId: null,
    });

    const promoted = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) =>
        tx
          .update(chatThreads)
          .set({ workspaceId: ids.wsA1 })
          .where(eq(chatThreads.id, threadId))
          .returning({ id: chatThreads.id }),
      ids.userA1,
    );
    expect(promoted).toEqual([{ id: threadId }]);

    const turns = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) =>
        tx
          .select({ workspaceId: chatTurns.workspaceId })
          .from(chatTurns)
          .where(eq(chatTurns.id, turnId)),
      ids.userA1,
    );
    expect(turns).toEqual([{ workspaceId: ids.wsA1 }]);
  });

  test("moves an origin-scoped draft and every durable turn into its destination workspace", async () => {
    const { threadId, turnId } = await seedTurnBackedThread({
      workspaceId: ids.wsA2,
    });

    const promoted = await scopedQuery(
      [ids.wsA1, ids.wsA2],
      ids.orgA,
      (tx) =>
        tx
          .update(chatThreads)
          .set({ workspaceId: ids.wsA1 })
          .where(eq(chatThreads.id, threadId))
          .returning({ id: chatThreads.id }),
      ids.userA1,
    );
    expect(promoted).toEqual([{ id: threadId }]);

    const turns = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) =>
        tx
          .select({ workspaceId: chatTurns.workspaceId })
          .from(chatTurns)
          .where(eq(chatTurns.id, turnId)),
      ids.userA1,
    );
    expect(turns).toEqual([{ workspaceId: ids.wsA1 }]);
  });

  test("rejects a direct turn workspace mismatch", async () => {
    const { turnId } = await seedTurnBackedThread({ workspaceId: null });

    await expectRlsDenied(
      async () =>
        await scopedQuery(
          [ids.wsA1],
          ids.orgA,
          (tx) =>
            tx
              .update(chatTurns)
              .set({ workspaceId: ids.wsA1 })
              .where(eq(chatTurns.id, turnId)),
          ids.userA1,
        ),
    );
  });

  test("rejects promotion into an inaccessible workspace", async () => {
    const { threadId, turnId } = await seedTurnBackedThread({
      workspaceId: null,
    });

    await expectRlsDenied(
      async () =>
        await scopedQuery(
          [ids.wsA1],
          ids.orgA,
          (tx) =>
            tx
              .update(chatThreads)
              .set({ workspaceId: ids.wsB1 })
              .where(eq(chatThreads.id, threadId)),
          ids.userA1,
        ),
    );

    const turns = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) =>
        tx
          .select({ workspaceId: chatTurns.workspaceId })
          .from(chatTurns)
          .where(eq(chatTurns.id, turnId)),
      ids.userA1,
    );
    expect(turns).toEqual([{ workspaceId: null }]);
  });
});
