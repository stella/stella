import type { StreamChunk } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  claimChatTurnForExecution,
  createChatTurnAcceptance,
  insertChatTurnAcceptanceOnTx,
  OWNER_LOST_OUTCOME,
  reapOwnerlessChatTurnOnTx,
  settleChatTurnOnTx,
  startChatTurnRun,
} from "@/api/handlers/chat/chat-turn-persistence";
import type { ChatTurnExecution } from "@/api/handlers/chat/chat-turn-persistence";
import {
  CHAT_TURN_OWNER_LOST_REASON,
  ChatTurnRun,
  relinquishChatTurnRuns,
} from "@/api/handlers/chat/chat-turn-run";
import type { ChatTurnOutcome } from "@/api/handlers/chat/types";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// A producing run holds its turn by a heartbeat lease. It renews the lease,
// stops producing once the turn is no longer its own, and on shutdown stores
// what it has as `owner-lost`. A run id names one turn in its organization.

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  safeDb = toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    ),
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

const unwrap = <T>(result: Result<T, unknown>): T =>
  Result.isError(result)
    ? panic("Unexpected failure", result.error)
    : result.value;

const noAudit: AuditRecorder = async () => {
  await Promise.resolve();
};

const seedRunningTurn = async () => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  const userMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Run ownership test",
    userId: ids.userA1,
    workspaceId: ids.wsA1,
  });
  const acceptance = createChatTurnAcceptance({
    organizationId: ids.orgA,
    threadId,
    userId: ids.userA1,
    userMessageId,
    workspaceId: ids.wsA1,
  });
  unwrap(
    await safeDb(async (tx) => {
      await tx.insert(chatMessages).values({
        content: { data: [{ text: "Draft it", type: "text" }], version: 1 },
        id: userMessageId,
        role: "user",
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      });
      await insertChatTurnAcceptanceOnTx({ acceptance, tx });
    }),
  );
  const execution = unwrap(
    await claimChatTurnForExecution({
      acceptedTurnId: acceptance.id,
      incomingMessageId: userMessageId,
      incomingMessageRole: "user",
      organizationId: ids.orgA,
      safeDb,
      threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    }),
  );
  return {
    execution: execution ?? panic("Expected the accepted turn to be claimed"),
    threadId,
  };
};

const readTurn = async (turnId: SafeId<"chatTurn">) =>
  (await testDb.query.chatTurns.findFirst({ where: { id: { eq: turnId } } })) ??
  panic("Expected the turn row");

/** How a cut-short run ends: `streamChat` maps its abort reason the same. */
const cutShortOutcome = (reason: unknown): ChatTurnOutcome =>
  reason === CHAT_TURN_OWNER_LOST_REASON
    ? OWNER_LOST_OUTCOME
    : { reason: "client-disconnected", type: "interrupted" };

/**
 * A run that produces nothing until it is cut short, then settles its turn
 * with the outcome its abort names. `stored` says how that settlement went.
 */
const produceUntilCut = ({
  execution,
  heartbeat,
  threadId,
}: {
  execution: ChatTurnExecution;
  heartbeat: { intervalMs: number; renewEvery: number };
  threadId: SafeId<"chatThread">;
}) => {
  const run = new ChatTurnRun({
    connectors: undefined,
    deadlineMs: 60_000,
    heartbeat,
    owner: {
      execution,
      owningAssistantMessage: undefined,
      recordAuditEvent: noAudit,
      safeDb,
      threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    },
  });
  const stored: { settlement?: string } = {};
  const { signal } = run.control.abortController;
  const output = async function* (): AsyncGenerator<StreamChunk> {
    if (!signal.aborted) {
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
    }
    await run.settle(async () => {
      stored.settlement = unwrap(
        await safeDb(
          async (tx) =>
            await settleChatTurnOnTx({
              assistantMessageId: null,
              execution,
              outcome: cutShortOutcome(signal.reason),
              tx,
            }),
        ),
      );
    });
  };
  const response = run.produce(output());
  return { response, run, stored };
};

const expireLease = async (turnId: SafeId<"chatTurn">) => {
  await testDb
    .update(chatTurns)
    .set({
      leaseExpiresAt: sql`${chatTurns.createdAt} + interval '1 millisecond'`,
    })
    .where(eq(chatTurns.id, turnId));
};

describe("a producing run", () => {
  test("keeps its turn by renewing the lease on its heartbeat", async () => {
    const { execution, threadId } = await seedRunningTurn();
    await expireLease(execution.id);
    const { response, run } = produceUntilCut({
      execution,
      heartbeat: { intervalMs: 5, renewEvery: 2 },
      threadId,
    });
    for (let poll = 0; poll < 400; poll += 1) {
      const { leaseExpiresAt } = await readTurn(execution.id);
      if (leaseExpiresAt !== null && leaseExpiresAt > new Date()) {
        break;
      }
      await Bun.sleep(5);
    }
    // Renewed past now: the reaper leaves a live owner's turn alone.
    unwrap(
      await safeDb(
        async (tx) => await reapOwnerlessChatTurnOnTx({ threadId, tx }),
      ),
    );
    expect((await readTurn(execution.id)).status).toBe("running");
    await run.stop();
    await response.body?.cancel();
  });

  test("stops producing once its turn is no longer its own, leaving the reaper's outcome", async () => {
    const { execution, threadId } = await seedRunningTurn();
    // Renewing only rarely, so the reaper finds the lease expired first.
    const { response, run, stored } = produceUntilCut({
      execution,
      heartbeat: { intervalMs: 5, renewEvery: 1000 },
      threadId,
    });
    await expireLease(execution.id);
    unwrap(
      await safeDb(
        async (tx) => await reapOwnerlessChatTurnOnTx({ threadId, tx }),
      ),
    );

    await run.settled;
    expect(run.control.abortController.signal.reason).toBe(
      CHAT_TURN_OWNER_LOST_REASON,
    );
    // The former owner's own settlement is fenced off.
    expect(stored.settlement).toBe("not-owned");
    expect(await readTurn(execution.id)).toMatchObject({
      executionId: null,
      interruptionReason: "owner-lost",
      status: "interrupted",
    });
    await response.body?.cancel();
  });

  test("is not cut short by its own settlement", async () => {
    const { execution, threadId } = await seedRunningTurn();
    const run = new ChatTurnRun({
      connectors: undefined,
      deadlineMs: 60_000,
      heartbeat: { intervalMs: 1, renewEvery: 1 },
      owner: {
        execution,
        owningAssistantMessage: undefined,
        recordAuditEvent: noAudit,
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      },
    });
    const output = async function* (): AsyncGenerator<StreamChunk> {
      await run.settle(async () => {
        unwrap(
          await safeDb(
            async (tx) =>
              await settleChatTurnOnTx({
                assistantMessageId: null,
                execution,
                outcome: { reason: "client-disconnected", type: "interrupted" },
                tx,
              }),
          ),
        );
        // The turn is no longer running while the settlement finishes: a
        // beat now would read it as lost.
        await Bun.sleep(30);
      });
      yield* [];
    };
    const response = run.produce(output());
    await response.text();

    expect(run.control.abortController.signal.aborted).toBe(false);
  });

  test("stores what it has as owner-lost when its process shuts down", async () => {
    const { execution, threadId } = await seedRunningTurn();
    const { response, stored } = produceUntilCut({
      execution,
      heartbeat: { intervalMs: 60_000, renewEvery: 4 },
      threadId,
    });

    await relinquishChatTurnRuns();

    expect(stored.settlement).toBe("settled");
    expect(await readTurn(execution.id)).toMatchObject({
      interruptionReason: "owner-lost",
      status: "interrupted",
    });
    await response.body?.cancel();
  });
});

describe("a run id", () => {
  test("names one turn in its organization, and the turn keeps it once settled", async () => {
    const first = await seedRunningTurn();
    const second = await seedRunningTurn();
    const runId = `run-${Bun.randomUUIDv7()}`;

    expect(
      unwrap(
        await startChatTurnRun({
          execution: first.execution,
          runId,
          safeDb,
        }),
      ),
    ).toBe("owned");
    // Starting the same run again, as a retried dispatch would, keeps it.
    expect(
      unwrap(
        await startChatTurnRun({
          execution: first.execution,
          runId,
          safeDb,
        }),
      ),
    ).toBe("owned");
    expect(
      unwrap(
        await startChatTurnRun({
          execution: second.execution,
          runId,
          safeDb,
        }),
      ),
    ).toBe("run-taken");
    expect((await readTurn(second.execution.id)).runId).toBeNull();

    unwrap(
      await safeDb(
        async (tx) =>
          await settleChatTurnOnTx({
            assistantMessageId: null,
            execution: first.execution,
            outcome: OWNER_LOST_OUTCOME,
            tx,
          }),
      ),
    );
    expect(await readTurn(first.execution.id)).toMatchObject({
      runId,
      status: "interrupted",
    });
    // Settled, the turn still holds the id.
    expect(
      unwrap(
        await startChatTurnRun({
          execution: second.execution,
          runId,
          safeDb,
        }),
      ),
    ).toBe("run-taken");
  });
});
