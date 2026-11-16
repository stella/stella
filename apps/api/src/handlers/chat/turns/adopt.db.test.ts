import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  toPersistableChatMessage,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import {
  adoptHandedOverChatTurn,
  claimChatTurnForExecution,
  createChatTurnAcceptance,
  insertChatTurnAcceptanceOnTx,
} from "@/api/handlers/chat/chat-turn-persistence";
import type { ChatTurnExecution } from "@/api/handlers/chat/chat-turn-persistence";
import {
  loadStoredTurnSettlement,
  persistStreamedTurn,
} from "@/api/handlers/chat/turns/settle";
import type { StreamedTurnSettlementContext } from "@/api/handlers/chat/turns/settle";
import type {
  ChatPart,
  PersistableTerminalAssistantMessage,
} from "@/api/handlers/chat/types";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withChatRunPings } from "@/api/lib/chat/chat-run-pings";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// A turn whose task stopped and released it, taken over by another task:
// one claim wins, and from then on only the adopter's execution settles it.

let testDb: TestDatabase;
let ids: TestIds;
const seededThreads: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  if (seededThreads.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreads));
  }
  await releaseRlsFixture();
});

const safeDbOf = (userId: SafeId<"user">, workspaceId: SafeId<"workspace">) =>
  toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, [workspaceId], ids.orgA, userId),
    ),
  );

const noAudit: AuditRecorder = async () => {
  await Promise.resolve();
};

const READING = { content: "Reading the files.", type: "text" } as const;
const DONE = { content: "Done.", type: "text" } as const;
type SeededTurn = {
  checkpointMessageId: SafeId<"chatMessage">;
  execution: ChatTurnExecution;
  threadId: SafeId<"chatThread">;
};

/**
 * A running turn of user A1 whose thread holds the answer it continues, as a
 * continuation after a member's answer leaves it.
 */
const seedRunningTurnWithCheckpoint = async (): Promise<SeededTurn> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  const userMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  const checkpointMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  seededThreads.push(threadId);
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Adopt a handed-over turn",
    userId: ids.userA1,
    workspaceId: ids.wsA1,
  });
  await testDb.insert(chatMessages).values({
    id: userMessageId,
    threadId,
    userId: ids.userA1,
    workspaceId: ids.wsA1,
    role: "user",
    content: toPersistedChatMessageContentV3({
      data: [{ content: "List the files", type: "text" }],
    }),
  });
  const acceptance = createChatTurnAcceptance({
    source: { type: "member" },
    organizationId: ids.orgA,
    threadId,
    userId: ids.userA1,
    userMessageId,
    workspaceId: ids.wsA1,
  });
  const safeDb = safeDbOf(ids.userA1, ids.wsA1);
  const inserted = await withChatRunPings(
    async (pings) =>
      await safeDb(
        async (tx) =>
          await insertChatTurnAcceptanceOnTx({ pings, acceptance, tx }),
      ),
  );
  if (Result.isError(inserted)) {
    panic("Could not seed chat turn", inserted.error);
  }
  const claimed = await claimChatTurnForExecution({
    acceptedTurnId: acceptance.id,
    incomingMessageId: userMessageId,
    incomingMessageRole: "user",
    organizationId: ids.orgA,
    safeDb,
    threadId,
    userId: ids.userA1,
    workspaceId: ids.wsA1,
  });
  if (Result.isError(claimed)) {
    panic("Could not claim seeded chat turn", claimed.error);
  }
  await testDb.insert(chatMessages).values({
    id: checkpointMessageId,
    threadId,
    userId: ids.userA1,
    workspaceId: ids.wsA1,
    role: "assistant",
    content: toPersistedChatMessageContentV3({ data: [READING] }),
  });
  return {
    checkpointMessageId,
    execution: claimed.value ?? panic("Expected the seeded turn claimed"),
    threadId,
  };
};

const memberOf = (userId: SafeId<"user">, safeDb: SafeDb) => ({
  getActiveWorkspaceIds: async () => await Promise.resolve([ids.wsA1]),
  recordAuditEvent: noAudit,
  safeDb,
  user: { id: userId, email: `${userId}@example.test` },
});

const load = async (
  seeded: SeededTurn,
  member = memberOf(ids.userA1, safeDbOf(ids.userA1, ids.wsA1)),
) => {
  const loaded = await loadStoredTurnSettlement({
    checkpointMessageId: seeded.checkpointMessageId,
    createRefRegistry: createChatRefRegistry,
    execution: seeded.execution,
    indexThread: async () => {},
    member,
    threadId: seeded.threadId,
  });
  if (Result.isError(loaded)) {
    panic("Could not read the stored turn", loaded.error);
  }
  return loaded.value;
};

const loadedContext = async (
  seeded: SeededTurn,
): Promise<StreamedTurnSettlementContext> => {
  const loaded = await load(seeded);
  if (loaded.type !== "loaded") {
    return panic(`Expected the stored turn loaded, got ${loaded.type}`);
  }
  return loaded.context;
};

const completedAnswer = (
  seeded: SeededTurn,
  parts: ChatPart[],
): PersistableTerminalAssistantMessage => ({
  ...toPersistableChatMessage({
    id: seeded.checkpointMessageId,
    parts,
    role: "assistant",
  }),
  metadata: { turnOutcome: { type: "completed" } },
  role: "assistant",
});

const readTurn = async (turnId: SafeId<"chatTurn">) =>
  (await testDb.query.chatTurns.findFirst({ where: { id: { eq: turnId } } })) ??
  panic("Expected the turn row");

const RUN_ID = "chat-run-adopted";

/**
 * Release the seeded turn as a stopping task does: its answer so far stored,
 * no owner, adoptable until `adoptBy`.
 */
const handOver = async (seeded: SeededTurn, adoptBy: "future" | "past") => {
  await testDb
    .update(chatTurns)
    .set({
      assistantMessageId: seeded.checkpointMessageId,
      executionId: null,
      leaseExpiresAt:
        adoptBy === "future"
          ? sql`now() + interval '90 seconds'`
          : sql`now() - interval '1 second'`,
      runId: RUN_ID,
      status: "handed-over",
    })
    .where(eq(chatTurns.id, seeded.execution.id));
};

const adopt = async (seeded: SeededTurn) => {
  const adopted = await adoptHandedOverChatTurn({
    safeDb: safeDbOf(ids.userA1, ids.wsA1),
    threadId: seeded.threadId,
    turnId: seeded.execution.id,
  });
  if (Result.isError(adopted)) {
    return panic("Could not adopt the turn", adopted.error);
  }
  return adopted.value;
};

describe("adopting a handed-over turn", () => {
  test("exactly one of many adopters takes the turn", async () => {
    const seeded = await seedRunningTurnWithCheckpoint();
    await handOver(seeded, "future");

    const claims = await Promise.all(
      Array.from({ length: 8 }, async () => await adopt(seeded)),
    );

    const winners = claims.flatMap((claim) => (claim === null ? [] : [claim]));
    expect(winners).toHaveLength(1);
    const [winner] = winners;
    expect(winner?.checkpointMessageId).toBe(seeded.checkpointMessageId);
    expect(winner?.runId).toBe(RUN_ID);
    const turn = await readTurn(seeded.execution.id);
    expect(turn.status).toBe("running");
    expect(turn.executionId).toBe(winner?.execution.executionId ?? null);
    expect(turn.executionId).not.toBe(seeded.execution.executionId);
    expect(turn.assistantMessageId).toBeNull();
  });

  test("takes no turn past its adopt-by", async () => {
    const seeded = await seedRunningTurnWithCheckpoint();
    await handOver(seeded, "past");

    expect(await adopt(seeded)).toBeNull();
    expect((await readTurn(seeded.execution.id)).status).toBe("handed-over");
  });

  test("takes no running turn", async () => {
    const seeded = await seedRunningTurnWithCheckpoint();

    expect(await adopt(seeded)).toBeNull();
    expect((await readTurn(seeded.execution.id)).executionId).toBe(
      seeded.execution.executionId,
    );
  });

  test("refuses the released owner's settlement and stores the adopter's", async () => {
    const seeded = await seedRunningTurnWithCheckpoint();
    const released = await loadedContext(seeded);
    await handOver(seeded, "future");
    const adopted = (await adopt(seeded)) ?? panic("Expected the turn adopted");
    const answer = {
      outcome: { type: "completed" },
      responseMessage: completedAnswer(seeded, [READING, DONE]),
    } as const;

    const late = await persistStreamedTurn({
      context: released,
      event: answer,
    });
    expect(late.isOk() ? late.value.settlement : late.error).toEqual({
      type: "not-owned",
    });
    expect((await readTurn(seeded.execution.id)).status).toBe("running");

    const stored = await persistStreamedTurn({
      context: await loadedContext({ ...seeded, execution: adopted.execution }),
      event: answer,
    });
    expect(stored.isOk() ? stored.value.settlement : stored.error).toEqual({
      type: "stored",
      outcome: { type: "completed" },
    });
    expect((await readTurn(seeded.execution.id)).status).toBe("completed");
  });
});
