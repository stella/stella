import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import {
  bindChatTurnRunId,
  claimChatTurnForExecution,
  createChatTurnAcceptance,
  insertChatTurnAcceptanceOnTx,
  isChatTurnRunIdTaken,
  OWNER_LOST_OUTCOME,
  reapOwnerlessChatTurnOnTx,
  CHAT_TURN_RUN_LEASE_MS,
  settleChatTurnOnTx,
  startChatTurnRun,
} from "@/api/handlers/chat/chat-turn-persistence";
import type { ChatTurnExecution } from "@/api/handlers/chat/chat-turn-persistence";
import {
  CHAT_TURN_OWNER_LOST_REASON,
  ChatTurnOwnership,
  ChatTurnRun,
} from "@/api/handlers/chat/chat-turn-run";
import type { ChatTurnStoredSettlement } from "@/api/handlers/chat/chat-turn-run";
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
/** Another member of the same organization, who cannot read the first's turns. */
let otherMember: Member;
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
  otherMember = {
    safeDb: toSafeDbMock(
      asTestRaw<ScopedDb>(
        createScopedDb(testDb, [ids.wsA2], ids.orgA, ids.userA2),
      ),
    ),
    userId: ids.userA2,
    workspaceId: ids.wsA2,
  };
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

type Member = {
  safeDb: SafeDb;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

const seedRunningTurn = async (member?: Member) => {
  const as = member ?? { safeDb, userId: ids.userA1, workspaceId: ids.wsA1 };
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  const userMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Run ownership test",
    userId: as.userId,
    workspaceId: as.workspaceId,
  });
  const acceptance = createChatTurnAcceptance({
    organizationId: ids.orgA,
    threadId,
    userId: as.userId,
    userMessageId,
    workspaceId: as.workspaceId,
  });
  unwrap(
    await as.safeDb(async (tx) => {
      await tx.insert(chatMessages).values({
        content: { data: [{ text: "Draft it", type: "text" }], version: 1 },
        id: userMessageId,
        role: "user",
        threadId,
        userId: as.userId,
        workspaceId: as.workspaceId,
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
      safeDb: as.safeDb,
      threadId,
      userId: as.userId,
      workspaceId: as.workspaceId,
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
 * A run that settles after an abort or after its finite chunk source ends.
 * `stored` says how that settlement went.
 */
const produceUntilCut = ({
  chunks,
  end = "on-abort",
  execution,
  heartbeat,
  ownerDb = safeDb,
  ownership = new ChatTurnOwnership(),
  persist,
  threadId,
}: {
  chunks?: AsyncIterable<StreamChunk>;
  end?: "on-abort" | "after-chunks";
  execution: ChatTurnExecution;
  heartbeat: { intervalMs: number; renewEvery: number };
  /** The database the run's heartbeat reads its turn through. */
  ownerDb?: SafeDb;
  ownership?: ChatTurnOwnership;
  /** Stores the cut; the turn's own settlement by default. */
  persist?: () => Promise<ChatTurnStoredSettlement>;
  threadId: SafeId<"chatThread">;
}) => {
  const run = new ChatTurnRun({
    connectors: undefined,
    deadlineMs: 60_000,
    mode: "raw",
    heartbeat,
    ownership,
    owner: {
      indexThread: async () => await Promise.resolve(),
      execution,
      owningAssistantMessage: undefined,
      recordAuditEvent: noAudit,
      safeDb: ownerDb,
      threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    },
  });
  const stored: { settlement?: string } = {};
  const { signal } = run.control.abortController;
  const output = async function* (): AsyncGenerator<StreamChunk> {
    if (chunks !== undefined) {
      yield* chunks;
    }
    let outcome: ChatTurnOutcome;
    switch (end) {
      case "on-abort":
        if (!signal.aborted) {
          await new Promise((resolve) => {
            signal.addEventListener("abort", resolve, { once: true });
          });
        }
        outcome = cutShortOutcome(signal.reason);
        break;
      case "after-chunks":
        outcome = { type: "completed" };
        break;
      default:
        end satisfies never;
        return panic(`Unknown run end: ${String(end)}`);
    }
    await run.settle(
      persist ??
        (async () => {
          const settlement = unwrap(
            await safeDb(async (tx) => {
              const assistantMessageId =
                outcome.type === "completed"
                  ? toSafeId<"chatMessage">(Bun.randomUUIDv7())
                  : null;
              if (assistantMessageId !== null) {
                await tx.insert(chatMessages).values({
                  content: toPersistedChatMessageContentV3({
                    data: [{ content: "Done", type: "text" }],
                    metadata: { turnOutcome: outcome },
                  }),
                  id: assistantMessageId,
                  role: "assistant",
                  threadId,
                  userId: ids.userA1,
                  workspaceId: ids.wsA1,
                });
              }
              return await settleChatTurnOnTx({
                assistantMessageId,
                execution,
                outcome,
                tx,
              });
            }),
          );
          stored.settlement = settlement;
          return settlement === "not-owned"
            ? { type: "not-owned" }
            : { type: "stored", outcome };
        }),
    );
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
  test("bounds an unread delivery without pausing its owned producer", async () => {
    const { execution, threadId } = await seedRunningTurn();
    const drained = Promise.withResolvers<undefined>();
    const chunks = async function* (): AsyncGenerator<StreamChunk> {
      for (let index = 0; index < 4; index += 1) {
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "buffer-test",
          delta: "x".repeat(600_000),
        };
      }
      drained.resolve(undefined);
    };
    const { response, run } = produceUntilCut({
      chunks: chunks(),
      execution,
      threadId,
      heartbeat: { intervalMs: 5000, renewEvery: 4 },
    });
    try {
      await drained.promise;
      expect(run.control.abortController.signal.aborted).toBe(false);
      expect(await rejectionOf(response.text())).toMatchObject({
        message: expect.stringContaining("Chat delivery exceeded its buffer"),
      });
    } finally {
      await run.stop();
    }
    expect((await readTurn(execution.id)).status).toBe("interrupted");
  });

  test("an overflowing delivery preserves a naturally completed turn", async () => {
    const { execution, threadId } = await seedRunningTurn();
    const chunks = async function* (): AsyncGenerator<StreamChunk> {
      for (let index = 0; index < 4; index += 1) {
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "completed-buffer-test",
          delta: "x".repeat(600_000),
        };
      }
    };
    const { response, run } = produceUntilCut({
      chunks: chunks(),
      end: "after-chunks",
      execution,
      threadId,
      heartbeat: { intervalMs: 5000, renewEvery: 4 },
    });
    try {
      expect(await run.settled).toBe("stored");
      expect(run.control.abortController.signal.aborted).toBe(false);
      expect(await rejectionOf(response.text())).toMatchObject({
        message: expect.stringContaining("Chat delivery exceeded its buffer"),
      });
      expect((await readTurn(execution.id)).status).toBe("completed");
    } finally {
      await run.stop();
    }
  });

  test("cancelling queued delivery after EOF preserves the completed turn", async () => {
    const { execution, threadId } = await seedRunningTurn();
    const chunks = async function* (): AsyncGenerator<StreamChunk> {
      for (let index = 0; index < 3; index += 1) {
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "queued-eof-test",
          delta: "queued",
        };
      }
    };
    const { response, run } = produceUntilCut({
      chunks: chunks(),
      end: "after-chunks",
      execution,
      threadId,
      heartbeat: { intervalMs: 5000, renewEvery: 4 },
    });
    try {
      expect(await run.settled).toBe("stored");
      // Let the transport's pending iterator read observe EOF after settlement.
      await Bun.sleep(0);
      const body = response.body ?? panic("Expected queued turn delivery");
      await body.cancel();
      expect(run.control.abortController.signal.aborted).toBe(false);
      expect((await readTurn(execution.id)).status).toBe("completed");
    } finally {
      await run.stop();
    }
  });

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
      mode: "raw",
      heartbeat: { intervalMs: 1, renewEvery: 1 },
      owner: {
        indexThread: async () => await Promise.resolve(),
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
                outcome: {
                  reason: "client-disconnected",
                  type: "interrupted",
                },
                tx,
              }),
          ),
        );
        // The turn is no longer running while the settlement finishes: a
        // beat now would read it as lost.
        await Bun.sleep(30);
        return {
          type: "stored",
          outcome: { reason: "client-disconnected", type: "interrupted" },
        };
      });
      yield* [];
    };
    const response = run.produce(output());
    await response.text();

    expect(run.control.abortController.signal.aborted).toBe(false);
  });

  test("stores what it has as owner-lost when its process gives up its turns", async () => {
    const { execution, threadId } = await seedRunningTurn();
    const ownership = new ChatTurnOwnership();
    const { response, stored } = produceUntilCut({
      execution,
      heartbeat: { intervalMs: 60_000, renewEvery: 4 },
      ownership,
      threadId,
    });

    expect(await ownership.relinquish()).toBe("stored");

    expect(stored.settlement).toBe("settled");
    expect(await readTurn(execution.id)).toMatchObject({
      interruptionReason: "owner-lost",
      status: "interrupted",
    });
    await response.body?.cancel();
  });

  test("gives a turn still in preflight the short lease, and cuts short the run it starts", async () => {
    const { execution, threadId } = await seedRunningTurn();
    const ownership = new ChatTurnOwnership();
    const releaseClaim = ownership.holdClaim({ execution, safeDb });
    // The claim's lease covers preflight: well past the run lease.
    const claimedLease = (await readTurn(execution.id)).leaseExpiresAt;
    expect(claimedLease?.getTime() ?? 0).toBeGreaterThan(
      Date.now() + CHAT_TURN_RUN_LEASE_MS * 2,
    );

    const relinquished = ownership.relinquish();
    for (let poll = 0; poll < 400; poll += 1) {
      const { leaseExpiresAt } = await readTurn(execution.id);
      if ((leaseExpiresAt?.getTime() ?? 0) < (claimedLease?.getTime() ?? 0)) {
        break;
      }
      await Bun.sleep(5);
    }
    expect(
      (await readTurn(execution.id)).leaseExpiresAt?.getTime() ?? 0,
    ).toBeLessThanOrEqual(Date.now() + CHAT_TURN_RUN_LEASE_MS);

    // The send hands its turn to a run, as `startRun` does: run first.
    const { response, run } = produceUntilCut({
      execution,
      heartbeat: { intervalMs: 60_000, renewEvery: 4 },
      ownership,
      threadId,
    });
    releaseClaim();

    expect(await relinquished).toBe("stored");
    expect(run.control.abortController.signal.reason).toBe(
      CHAT_TURN_OWNER_LOST_REASON,
    );
    expect(await readTurn(execution.id)).toMatchObject({
      interruptionReason: "owner-lost",
      status: "interrupted",
    });
    await response.body?.cancel();
  });

  test("is over only once a beat still reading its turn is done", async () => {
    const { execution, threadId } = await seedRunningTurn();
    const ownership = new ChatTurnOwnership();
    const beatStarted = Promise.withResolvers<undefined>();
    const beatMayFinish = Promise.withResolvers<undefined>();
    // The heartbeat's reads wait here: a beat is in flight until let go.
    const heldDb: SafeDb = async (callback, retry) => {
      beatStarted.resolve(undefined);
      await beatMayFinish.promise;
      return await safeDb(callback, retry);
    };
    const { response, run } = produceUntilCut({
      execution,
      heartbeat: { intervalMs: 1, renewEvery: 1000 },
      ownerDb: heldDb,
      ownership,
      threadId,
    });
    await beatStarted.promise;

    const relinquished = ownership.relinquish();
    let over = false;
    const settled = run.settled.then((end) => {
      over = true;
      return end;
    });
    // The run stored its outcome, but a beat still reads its turn.
    for (let poll = 0; poll < 40; poll += 1) {
      await Bun.sleep(1);
    }
    expect((await readTurn(execution.id)).status).toBe("interrupted");
    expect(over).toBe(false);

    beatMayFinish.resolve(undefined);
    expect(await settled).toBe("stored");
    expect(await relinquished).toBe("stored");
    await response.body?.cancel();
  });

  test("gives up its turns only once a run that settled on its own is done reading its turn", async () => {
    const { execution, threadId } = await seedRunningTurn();
    const ownership = new ChatTurnOwnership();
    const beatStarted = Promise.withResolvers<undefined>();
    const beatMayFinish = Promise.withResolvers<undefined>();
    const heldDb: SafeDb = async (callback, retry) => {
      beatStarted.resolve(undefined);
      await beatMayFinish.promise;
      return await safeDb(callback, retry);
    };
    const run = new ChatTurnRun({
      connectors: undefined,
      deadlineMs: 60_000,
      mode: "raw",
      heartbeat: { intervalMs: 1, renewEvery: 1000 },
      ownership,
      owner: {
        indexThread: async () => await Promise.resolve(),
        execution,
        owningAssistantMessage: undefined,
        recordAuditEvent: noAudit,
        safeDb: heldDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      },
    });
    // The run settles on its own while a beat is still reading its turn.
    const output = async function* (): AsyncGenerator<StreamChunk> {
      await beatStarted.promise;
      await run.settle(async () => {
        unwrap(
          await safeDb(
            async (tx) =>
              await settleChatTurnOnTx({
                assistantMessageId: null,
                execution,
                outcome: {
                  reason: "client-disconnected",
                  type: "interrupted",
                },
                tx,
              }),
          ),
        );
        return {
          type: "stored",
          outcome: { reason: "client-disconnected", type: "interrupted" },
        };
      });
      yield* [];
    };
    await run.produce(output()).text();
    expect(ownership.run(execution.executionId)).toBeUndefined();

    // Giving up the process's turns from here still waits for that beat.
    let relinquishedWith: string | undefined;
    const relinquished = ownership.relinquish().then((end) => {
      relinquishedWith = end;
      return end;
    });
    for (let poll = 0; poll < 40; poll += 1) {
      await Bun.sleep(1);
    }
    expect(relinquishedWith).toBeUndefined();

    beatMayFinish.resolve(undefined);
    expect(await relinquished).toBe("stored");
    expect(await run.settled).toBe("stored");
  });

  test("gives up its turns only once the work they left running is done", async () => {
    const { execution, threadId } = await seedRunningTurn();
    const ownership = new ChatTurnOwnership();
    const { response, run } = produceUntilCut({
      execution,
      heartbeat: { intervalMs: 60_000, renewEvery: 4 },
      ownership,
      threadId,
    });
    const followUpMayFinish = Promise.withResolvers<undefined>();
    let followUpDone = false;
    const followUp = run.followUp(
      followUpMayFinish.promise.finally(() => {
        followUpDone = true;
      }),
    );

    let relinquishedWith: string | undefined;
    const relinquished = ownership.relinquish().then((end) => {
      relinquishedWith = end;
      return end;
    });
    expect(await run.settled).toBe("stored");
    for (let poll = 0; poll < 40; poll += 1) {
      await Bun.sleep(1);
    }
    expect(relinquishedWith).toBeUndefined();

    followUpMayFinish.resolve(undefined);
    await relinquished;
    expect(followUpDone).toBe(true);
    await followUp;
    expect(relinquishedWith).toBe("stored");
    await response.body?.cancel();
  });

  test("reports a run that could not store its outcome", async () => {
    const { execution, threadId } = await seedRunningTurn();
    const ownership = new ChatTurnOwnership();
    const { response } = produceUntilCut({
      execution,
      heartbeat: { intervalMs: 60_000, renewEvery: 4 },
      ownership,
      persist: async () =>
        await Promise.reject(new Error("The database is unavailable")),
      threadId,
    });

    expect(await ownership.relinquish()).toBe("unstored");
    await response.body?.cancel();
  });
});

describe("a run id", () => {
  test("binding repeats for a live owner without changing its preflight expiry", async () => {
    const first = await seedRunningTurn();
    const second = await seedRunningTurn();
    const runId = `run-${Bun.randomUUIDv7()}`;
    const before = await readTurn(first.execution.id);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        unwrap(
          await bindChatTurnRunId({
            execution: first.execution,
            runId,
            safeDb,
          }),
        ),
      ).toBe("owned");
      const bound = await readTurn(first.execution.id);
      expect(bound.runId).toBe(runId);
      expect(bound.leaseExpiresAt).toEqual(before.leaseExpiresAt);
    }
    expect(
      unwrap(
        await bindChatTurnRunId({ execution: second.execution, runId, safeDb }),
      ),
    ).toBe("run-taken");
    unwrap(
      await safeDb(
        async (tx) =>
          await settleChatTurnOnTx({
            assistantMessageId: null,
            execution: first.execution,
            outcome: { type: "interrupted", reason: "client-disconnected" },
            tx,
          }),
      ),
    );
    expect((await readTurn(first.execution.id)).runId).toBe(runId);
    expect(
      unwrap(
        await bindChatTurnRunId({ execution: second.execution, runId, safeDb }),
      ),
    ).toBe("run-taken");
    expect(
      unwrap(
        await bindChatTurnRunId({ execution: first.execution, runId, safeDb }),
      ),
    ).toBe("lost");
  });

  test("concurrent bindings give a run id to exactly one owned turn", async () => {
    const first = await seedRunningTurn();
    const second = await seedRunningTurn();
    const runId = `run-${Bun.randomUUIDv7()}`;
    const outcomes = await Promise.all(
      [first, second].map(async ({ execution }) =>
        unwrap(await bindChatTurnRunId({ execution, runId, safeDb })),
      ),
    );
    expect(outcomes.toSorted()).toEqual(["owned", "run-taken"]);
  });

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
    expect(
      unwrap(
        await isChatTurnRunIdTaken({
          execution: first.execution,
          runId,
          safeDb,
        }),
      ),
    ).toBe(false);
    expect(
      unwrap(
        await isChatTurnRunIdTaken({
          execution: second.execution,
          runId,
          safeDb,
        }),
      ),
    ).toBe(true);
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

    // A turn the caller cannot read holds its id just the same.
    const hidden = await seedRunningTurn(otherMember);
    expect(
      unwrap(
        await isChatTurnRunIdTaken({
          execution: hidden.execution,
          runId,
          safeDb: otherMember.safeDb,
        }),
      ),
    ).toBe(true);
    expect(
      unwrap(
        await startChatTurnRun({
          execution: hidden.execution,
          runId,
          safeDb: otherMember.safeDb,
        }),
      ),
    ).toBe("run-taken");

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
