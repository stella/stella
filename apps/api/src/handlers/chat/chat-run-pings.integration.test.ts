import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { chatRunsChangedRealtimeEvent } from "@stll/api-contract";
import type { UserRealtimeEvent } from "@stll/api-contract";
import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { persistFailedChatTurn } from "@/api/handlers/chat/chat-message-persistence";
import {
  bindChatTurnRunId,
  claimChatTurnForExecution,
  createChatTurnAcceptance,
  insertChatTurnAcceptanceOnTx,
  reapOwnerlessChatTurnOnTx,
  renewChatTurnExecutionLease,
  settleChatTurnOnTx,
  startChatTurnRun,
  USER_STOP_OUTCOME,
} from "@/api/handlers/chat/chat-turn-persistence";
import type { ChatTurnExecution } from "@/api/handlers/chat/chat-turn-persistence";
import deleteThread from "@/api/handlers/chat/threads/delete";
import cancelTurn from "@/api/handlers/chat/turns/cancel";
import type { ChatPart, ChatTurnOutcome } from "@/api/handlers/chat/types";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withChatRunPings } from "@/api/lib/chat/chat-run-pings";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { createReapOwnerlessChatTurnsTask } from "@/api/lib/scheduler/tasks/chat-turn-reaper";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import * as sseModule from "@/api/lib/sse";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Every write that changes a chat turn's status tells the turn's owner, after
// its transaction, that their active runs changed; writes that leave the
// status alone tell nobody. Each path a status changes on is driven through
// its real persistence function, and the user channel is observed at the one
// function every ping goes through.

type Member = {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

type Ping = {
  event: UserRealtimeEvent;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

let testDb: TestDatabase;
let ids: TestIds;
let me: Member;
let colleague: Member;
const seededThreadIds: SafeId<"chatThread">[] = [];
const pings: Ping[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  const memberDb = (
    workspaceId: SafeId<"workspace">,
    userId: SafeId<"user">,
  ): SafeDb =>
    toSafeDbMock(
      asTestRaw<ScopedDb>(
        createScopedDb(testDb, [workspaceId], ids.orgA, userId),
      ),
    );
  me = {
    organizationId: ids.orgA,
    safeDb: memberDb(ids.wsA1, ids.userA1),
    userId: ids.userA1,
    workspaceId: ids.wsA1,
  };
  colleague = {
    organizationId: ids.orgA,
    safeDb: memberDb(ids.wsA2, ids.userA2),
    userId: ids.userA2,
    workspaceId: ids.wsA2,
  };
});

beforeEach(() => {
  pings.length = 0;
  spyOn(sseModule, "broadcastToUser").mockImplementation(
    (userId, organizationId, event) => {
      pings.push({ event, organizationId, userId });
    },
  );
});

afterEach(() => {
  mock.restore();
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

/** The pings sent since the last call, in order. */
const takePings = (): Ping[] => pings.splice(0);

const pingFor = (member: Member): Ping => ({
  event: chatRunsChangedRealtimeEvent(),
  organizationId: member.organizationId,
  userId: member.userId,
});

const awaitingParts = [
  {
    arguments:
      '{"analysis":"Need jurisdiction","questions":[{"question":"Which court?","reason":"Jurisdiction determines the law."}]}',
    id: "ask-1",
    input: {
      analysis: "Need jurisdiction",
      questions: [
        {
          question: "Which court?",
          reason: "Jurisdiction determines the law.",
        },
      ],
    },
    metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
    name: "ask-user",
    state: "input-complete",
    type: "tool-call",
  },
] satisfies ChatPart[];

const AWAITING_OUTCOME = {
  interaction: { toolCallId: "ask-1", type: "ask-user" },
  type: "awaiting-user",
} as const satisfies ChatTurnOutcome;

const seedThread = async (member: Member) => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: member.organizationId,
    title: "Run status ping test",
    userId: member.userId,
    workspaceId: member.workspaceId,
  });
  return threadId;
};

/** Accept a new user message on `threadId`, as a send does. */
const accept = async (member: Member, threadId: SafeId<"chatThread">) => {
  const userMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  const acceptance = createChatTurnAcceptance({
    organizationId: member.organizationId,
    threadId,
    userId: member.userId,
    userMessageId,
    workspaceId: member.workspaceId,
  });
  const accepted = unwrap(
    await withChatRunPings(
      async (collector) =>
        await member.safeDb(async (tx) => {
          await tx.insert(chatMessages).values({
            content: toPersistedChatMessageContentV3({
              data: [{ content: "Draft it", type: "text" }],
            }),
            id: userMessageId,
            role: "user",
            threadId,
            userId: member.userId,
            workspaceId: member.workspaceId,
          });
          return await insertChatTurnAcceptanceOnTx({
            acceptance,
            pings: collector,
            tx,
          });
        }),
    ),
  );
  expect(accepted.type).toBe("accepted");
  return { acceptance, userMessageId };
};

const claimAccepted = async (
  member: Member,
  threadId: SafeId<"chatThread">,
  { acceptance, userMessageId }: Awaited<ReturnType<typeof accept>>,
): Promise<ChatTurnExecution> =>
  unwrap(
    await claimChatTurnForExecution({
      acceptedTurnId: acceptance.id,
      incomingMessageId: userMessageId,
      incomingMessageRole: "user",
      organizationId: member.organizationId,
      safeDb: member.safeDb,
      threadId,
      userId: member.userId,
      workspaceId: member.workspaceId,
    }),
  ) ?? panic("Expected the accepted turn to be claimed");

/** Settle a running execution on `outcome`, storing its assistant message. */
const settle = async (
  member: Member,
  threadId: SafeId<"chatThread">,
  execution: ChatTurnExecution,
  outcome: ChatTurnOutcome,
) => {
  const assistantMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  const ownsMessage = outcome.type !== "cancelled";
  const settled = unwrap(
    await withChatRunPings(
      async (collector) =>
        await member.safeDb(async (tx) => {
          if (ownsMessage) {
            await tx.insert(chatMessages).values({
              content: toPersistedChatMessageContentV3({
                data:
                  outcome.type === "awaiting-user"
                    ? awaitingParts
                    : [{ content: "Drafted", type: "text" }],
              }),
              id: assistantMessageId,
              role: "assistant",
              threadId,
              userId: member.userId,
              workspaceId: member.workspaceId,
            });
          }
          return await settleChatTurnOnTx({
            assistantMessageId: ownsMessage ? assistantMessageId : null,
            execution,
            outcome,
            pings: collector,
            tx,
          });
        }),
    ),
  );
  expect(settled).toBe("settled");
  return assistantMessageId;
};

const readStatus = async (turnId: SafeId<"chatTurn">) =>
  (
    await testDb.query.chatTurns.findFirst({
      where: { id: { eq: turnId } },
      columns: { status: true },
    })
  )?.status;

const deleteThroughRoute = async (
  member: Member,
  threadId: SafeId<"chatThread">,
) =>
  await deleteThread.handler(
    asTestRaw<Parameters<typeof deleteThread.handler>[0]>({
      getWorkspaceAccess: async () => ({
        id: member.workspaceId,
        status: "active",
      }),
      memberRole: sessionMemberRole("owner"),
      params: { threadId },
      query: { workspaceId: member.workspaceId },
      recordAuditEvent: async () => {},
      request: new Request(`http://localhost/v1/chat/threads/${threadId}`, {
        method: "DELETE",
      }),
      route: "/v1/chat/threads/:threadId" satisfies ApiRoutePath,
      safeDb: member.safeDb,
      session: { activeOrganizationId: member.organizationId },
      set: { headers: {}, status: 200 },
      user: { id: member.userId },
    }),
  );

const stopThroughRoute = async (
  member: Member,
  threadId: SafeId<"chatThread">,
  turnId: SafeId<"chatTurn">,
) =>
  await cancelTurn.handler(
    asTestRaw<Parameters<typeof cancelTurn.handler>[0]>({
      memberRole: sessionMemberRole("owner"),
      params: { threadId, turnId },
      request: new Request(
        `http://localhost/v1/chat/threads/${threadId}/turns/${turnId}/cancel`,
        { method: "POST" },
      ),
      route:
        "/v1/chat/threads/:threadId/turns/:turnId/cancel" satisfies ApiRoutePath,
      safeDb: member.safeDb,
      session: { activeOrganizationId: member.organizationId },
      set: { headers: {}, status: 200 },
      user: { id: member.userId },
    }),
  );

describe("chat run status pings", () => {
  test("accepting, claiming, waiting on the member, resuming and completing each ping the owner once", async () => {
    const threadId = await seedThread(me);

    const accepted = await accept(me, threadId);
    expect(takePings()).toEqual([pingFor(me)]);

    const execution = await claimAccepted(me, threadId, accepted);
    expect(takePings()).toEqual([pingFor(me)]);

    const assistantMessageId = await settle(
      me,
      threadId,
      execution,
      AWAITING_OUTCOME,
    );
    expect(await readStatus(execution.id)).toBe("awaiting-user");
    expect(takePings()).toEqual([pingFor(me)]);

    const resumed =
      unwrap(
        await claimChatTurnForExecution({
          acceptedTurnId: null,
          continuationInteraction: { toolCallId: "ask-1", type: "ask-user" },
          incomingMessageId: assistantMessageId,
          incomingMessageRole: "assistant",
          organizationId: me.organizationId,
          safeDb: me.safeDb,
          threadId,
          userId: me.userId,
          workspaceId: me.workspaceId,
        }),
      ) ?? panic("Expected the awaiting turn to resume");
    expect(await readStatus(resumed.id)).toBe("running");
    expect(takePings()).toEqual([pingFor(me)]);

    await settle(me, threadId, resumed, { type: "completed" });
    expect(await readStatus(resumed.id)).toBe("completed");
    expect(takePings()).toEqual([pingFor(me)]);
  });

  test("binding a run and renewing its lease change no status and ping nobody", async () => {
    const threadId = await seedThread(me);
    const execution = await claimAccepted(
      me,
      threadId,
      await accept(me, threadId),
    );
    takePings();

    expect(
      unwrap(
        await bindChatTurnRunId({
          execution,
          runId: Bun.randomUUIDv7(),
          safeDb: me.safeDb,
        }),
      ),
    ).toBe("owned");
    expect(
      unwrap(
        await startChatTurnRun({
          execution,
          runId: Bun.randomUUIDv7(),
          safeDb: me.safeDb,
        }),
      ),
    ).toBe("owned");
    expect(
      unwrap(
        await renewChatTurnExecutionLease({ execution, safeDb: me.safeDb }),
      ),
    ).toBe("owned");

    expect(await readStatus(execution.id)).toBe("running");
    expect(takePings()).toEqual([]);
  });

  test("a failed run pings its owner through the failure the run stores", async () => {
    const threadId = await seedThread(me);
    const execution = await claimAccepted(
      me,
      threadId,
      await accept(me, threadId),
    );
    takePings();

    unwrap(
      await persistFailedChatTurn({
        code: "provider-error",
        execution,
        indexThread: async () => await Promise.resolve(),
        recordAuditEvent: async () => await Promise.resolve(),
        retryable: true,
        safeDb: me.safeDb,
        threadId,
        userId: me.userId,
        workspaceId: me.workspaceId,
      }),
    );

    expect(await readStatus(execution.id)).toBe("failed");
    expect(takePings()).toEqual([pingFor(me)]);
  });

  test("a run its owner settles as the member's stop pings once; recording the stop alone pings nobody", async () => {
    const threadId = await seedThread(me);
    const execution = await claimAccepted(
      me,
      threadId,
      await accept(me, threadId),
    );
    takePings();

    // A running turn's stop is only recorded: its owner settles it.
    await stopThroughRoute(me, threadId, execution.id);
    expect(await readStatus(execution.id)).toBe("running");
    expect(takePings()).toEqual([]);

    await settle(me, threadId, execution, USER_STOP_OUTCOME);
    expect(await readStatus(execution.id)).toBe("cancelled");
    expect(takePings()).toEqual([pingFor(me)]);
  });

  test("deleting a thread pings its owner, because its open turns go with it", async () => {
    const threadId = await seedThread(me);
    const { acceptance } = await accept(me, threadId);
    takePings();

    await deleteThroughRoute(me, threadId);

    expect(await readStatus(acceptance.id)).toBeUndefined();
    expect(takePings()).toEqual([pingFor(me)]);
  });

  test("the member's stop of a turn no run owns pings them", async () => {
    const accepted = await seedThread(me);
    const { acceptance } = await accept(me, accepted);
    takePings();
    await stopThroughRoute(me, accepted, acceptance.id);
    expect(await readStatus(acceptance.id)).toBe("cancelled");
    expect(takePings()).toEqual([pingFor(me)]);

    const awaiting = await seedThread(me);
    const execution = await claimAccepted(
      me,
      awaiting,
      await accept(me, awaiting),
    );
    await settle(me, awaiting, execution, AWAITING_OUTCOME);
    takePings();
    await stopThroughRoute(me, awaiting, execution.id);
    expect(await readStatus(execution.id)).toBe("cancelled");
    expect(takePings()).toEqual([pingFor(me)]);
  });

  test("a new message superseding a waiting turn pings its owner once for both writes", async () => {
    const threadId = await seedThread(me);
    const first = await accept(me, threadId);
    const execution = await claimAccepted(me, threadId, first);
    await settle(me, threadId, execution, AWAITING_OUTCOME);
    takePings();

    const next = await accept(me, threadId);

    expect(await readStatus(execution.id)).toBe("cancelled");
    expect(await readStatus(next.acceptance.id)).toBe("accepted");
    expect(takePings()).toEqual([pingFor(me)]);
  });

  test("the reaper ending a turn whose owner stopped pings that turn's owner", async () => {
    const mine = await seedThread(me);
    const myExecution = await claimAccepted(me, mine, await accept(me, mine));
    const theirs = await seedThread(colleague);
    const theirExecution = await claimAccepted(
      colleague,
      theirs,
      await accept(colleague, theirs),
    );
    takePings();
    // The colleague's owner stopped renewing; the member's is still live.
    await testDb
      .update(chatTurns)
      .set({
        leaseExpiresAt: sql`${chatTurns.createdAt} + interval '1 millisecond'`,
      })
      .where(eq(chatTurns.id, theirExecution.id));

    await createReapOwnerlessChatTurnsTask(reapOwnerlessChatTurnOnTx)(
      asTestRaw<SchedulerTaskContext>({
        db: testDb,
        logger: { info: () => undefined },
        signal: new AbortController().signal,
      }),
    );

    expect(await readStatus(theirExecution.id)).toBe("interrupted");
    expect(await readStatus(myExecution.id)).toBe("running");
    // The reaper visits every expired turn in the database, so other
    // owners may be pinged too; the colleague must be.
    expect(takePings()).toContainEqual(pingFor(colleague));
  });
});
