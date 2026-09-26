import { RUN_CANCEL_REASON } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import {
  CHAT_CONTINUATION_REJECTED_ERROR_CODE,
  CHAT_TURN_NOT_OWNED_ERROR_CODE,
} from "@stll/api-contract";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  auditLogs,
  chatMessages,
  chatThreads,
  chatTurns,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import {
  finalizeAssistantTurn,
  persistFailedChatTurn,
  persistInterruptedChatTurn,
} from "@/api/handlers/chat/chat-message-persistence";
import {
  claimChatTurnForExecution,
  createChatTurnAcceptance,
  insertChatTurnAcceptanceOnTx,
  renewChatTurnExecutionLease,
  settleChatTurnOnTx,
  stopChatTurnOnTx,
} from "@/api/handlers/chat/chat-turn-persistence";
import type { ChatTurnExecution } from "@/api/handlers/chat/chat-turn-persistence";
import { registerChatTurnProducer } from "@/api/handlers/chat/chat-turn-producers";
import type { CreateDocumentToolOutput } from "@/api/handlers/chat/tools/create-document-tool";
import { CREATE_DOCUMENT_TOOL_NAME } from "@/api/handlers/chat/tools/native-chat-tool-names";
import cancelTurn from "@/api/handlers/chat/turns/cancel";
import type { ChatPart, ChatTurnOutcome } from "@/api/handlers/chat/types";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createApprovalHarness } from "@/api/tests/helpers/chat-approval-harness";
import { CHAT_ORACLE } from "@/api/tests/helpers/chat-oracles";
import {
  findOfferedInteractions,
  findTurnOutcomeMismatches,
} from "@/api/tests/helpers/chat-thread-invariants";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// The Stop endpoint against the stored turn, one status at a time, and the
// owner's settlement once a stop is recorded: whichever way the owner would
// have ended the turn, it ends as the user's stop, and the turn row and its
// message say so together.

let testDb: TestDatabase;
let ids: TestIds;
let scopedDb: ScopedDb;
let safeDb: SafeDb;
let otherUserSafeDb: SafeDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
  otherUserSafeDb = toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsA2], ids.orgA, ids.userA2),
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

const USER_STOP = { reason: "user-stop", type: "cancelled" } as const;

const seedAcceptedTurn = async () => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  const userMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Stop test",
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
      expect(await insertChatTurnAcceptanceOnTx({ acceptance, tx })).toEqual({
        superseded: undefined,
        type: "accepted",
      });
    }),
  );
  return { threadId, turnId: acceptance.id, userMessageId };
};

const seedRunningTurn = async () => {
  const seeded = await seedAcceptedTurn();
  const execution = unwrap(
    await claimChatTurnForExecution({
      acceptedTurnId: seeded.turnId,
      incomingMessageId: seeded.userMessageId,
      incomingMessageRole: "user",
      organizationId: ids.orgA,
      safeDb,
      threadId: seeded.threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    }),
  );
  return {
    ...seeded,
    execution: execution ?? panic("Expected the accepted turn to be claimed"),
  };
};

const TEXT_PART = {
  content: "Here is the draft.",
  type: "text",
} satisfies ChatPart;
const COMPLETED_CALL = {
  arguments: "{}",
  id: "call-listed",
  input: {},
  name: "list_templates",
  output: { templates: [] },
  state: "complete",
  type: "tool-call",
} satisfies ChatPart;
const CLIENT_CALL = {
  arguments: JSON.stringify({ name: "NDA", source: "@title NDA" }),
  id: "call-draft",
  input: { name: "NDA", source: "@title NDA" },
  name: "create-document",
  state: "input-complete",
  type: "tool-call",
} satisfies ChatPart;
const APPROVAL_CALL = {
  approval: { id: "call-delete", needsApproval: true },
  arguments: JSON.stringify({ name: "NDA" }),
  id: "call-delete",
  input: { name: "NDA" },
  name: "mcp__external__delete",
  state: "approval-requested",
  type: "tool-call",
} satisfies ChatPart;

const seedAwaitingTurn = async () => {
  const seeded = await seedRunningTurn();
  const assistantMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  const interaction = {
    toolCallId: CLIENT_CALL.id,
    type: "client-tool",
  } as const;
  const message = toPersistableChatMessage({
    id: assistantMessageId,
    metadata: { turnOutcome: { interaction, type: "awaiting-user" } },
    parts: [TEXT_PART, COMPLETED_CALL, CLIENT_CALL],
    role: "assistant",
  });
  unwrap(
    await safeDb(async (tx) => {
      await tx.insert(chatMessages).values({
        content: chatMessageContentFromMessage(message),
        id: assistantMessageId,
        role: "assistant",
        threadId: seeded.threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      });
      expect(
        await settleChatTurnOnTx({
          assistantMessageId,
          execution: seeded.execution,
          outcome: { interaction, type: "awaiting-user" },
          tx,
        }),
      ).toBe("settled");
    }),
  );
  return { ...seeded, assistantMessageId };
};

type CancelCtx = Parameters<typeof cancelTurn.handler>[0];

/** The Stop route as the page calls it: the status and body it answers. */
const stop = async ({
  as = safeDb,
  threadId,
  turnId,
}: {
  as?: SafeDb | undefined;
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
}): Promise<{ body: unknown; status: unknown }> => {
  const set = { headers: {}, status: 200 };
  const answer: unknown = await cancelTurn.handler(
    asTestRaw<CancelCtx>({
      memberRole: { role: "owner" },
      params: { threadId, turnId },
      request: new Request(
        `http://localhost/v1/chat/threads/${threadId}/turns/${turnId}/cancel`,
        { method: "POST" },
      ),
      route: "/v1/chat/threads/:threadId/turns/:turnId/cancel",
      safeDb: as,
      session: { activeOrganizationId: ids.orgA },
      set,
      user: { id: ids.userA1 },
    }),
  );
  if (typeof answer !== "object" || answer === null) {
    return panic("The Stop route answered with nothing");
  }
  // A refusal is a status response; an answer is the body, with the status
  // the handler set.
  return "turn" in answer
    ? { body: answer, status: set.status }
    : {
        body: Reflect.get(answer, "response"),
        status: Reflect.get(answer, "code"),
      };
};

const readTurn = async (turnId: SafeId<"chatTurn">) =>
  (await testDb.query.chatTurns.findFirst({ where: { id: { eq: turnId } } })) ??
  panic("Expected the turn row");

const readMessage = async (messageId: SafeId<"chatMessage">) =>
  chatMessageFromPersisted(
    (await testDb.query.chatMessages.findFirst({
      where: { id: { eq: messageId } },
      columns: { content: true, id: true, role: true },
    })) ?? panic("Expected the message row"),
  );

const readThreadUpdatedAt = async (threadId: SafeId<"chatThread">) =>
  (
    (await testDb.query.chatThreads.findFirst({
      where: { id: { eq: threadId } },
      columns: { updatedAt: true },
    })) ?? panic("Expected the thread row")
  ).updatedAt;

const recordStop = async ({
  threadId,
  turnId,
}: {
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
}) =>
  unwrap(
    await safeDb(
      async (tx) => await stopChatTurnOnTx({ threadId, tx, turnId }),
    ),
  );

const noAudit: AuditRecorder = async () => {
  await Promise.resolve();
};

describe("stopping a chat turn", () => {
  test("cancels an accepted turn, which then never starts", async () => {
    const { threadId, turnId, userMessageId } = await seedAcceptedTurn();

    expect(await stop({ threadId, turnId })).toEqual({
      body: { turn: { id: turnId, reason: "user-stop", status: "cancelled" } },
      status: 200,
    });
    const row = await readTurn(turnId);
    expect({
      reason: row.cancellationReason,
      requested: row.cancelRequestedAt !== null,
      status: row.status,
    }).toEqual({ reason: "user-stop", requested: true, status: "cancelled" });
    expect(
      unwrap(
        await claimChatTurnForExecution({
          acceptedTurnId: turnId,
          incomingMessageId: userMessageId,
          incomingMessageRole: "user",
          organizationId: ids.orgA,
          safeDb,
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        }),
      ),
    ).toBeNull();
  });

  test("ends a turn waiting on the user, its message with it", async () => {
    const { assistantMessageId, threadId, turnId } = await seedAwaitingTurn();
    const revisionBefore = await readThreadUpdatedAt(threadId);
    // The fixture must reach the fault: the stored thread offers the call.
    expect(
      await findOfferedInteractions({ db: testDb, threadId }),
    ).toHaveLength(1);

    expect(await stop({ threadId, turnId })).toEqual({
      body: { turn: { id: turnId, reason: "user-stop", status: "cancelled" } },
      status: 200,
    });
    const message = await readMessage(assistantMessageId);
    expect(message.metadata?.turnOutcome).toEqual(USER_STOP);
    // The page's client call is stopped; what the turn completed stays.
    expect(message.parts).toEqual([
      TEXT_PART,
      COMPLETED_CALL,
      {
        arguments: CLIENT_CALL.arguments,
        id: CLIENT_CALL.id,
        name: CLIENT_CALL.name,
        state: "error",
        type: "tool-call",
      },
    ]);
    expect((await readTurn(turnId)).status).toBe("cancelled");
    expect(await findOfferedInteractions({ db: testDb, threadId })).toEqual([]);
    expect(await findTurnOutcomeMismatches({ db: testDb, threadId })).toEqual(
      [],
    );
    // The page learns its transcript changed in place from the revision.
    expect((await readThreadUpdatedAt(threadId)).getTime()).toBeGreaterThan(
      revisionBefore.getTime(),
    );
  });

  test("reports a settled turn as it stands, and changes nothing", async () => {
    const { execution, threadId, turnId } = await seedRunningTurn();
    const assistantMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    unwrap(
      await finalizeAssistantTurn({
        acceptedSendMode: null,
        existingIds: new Set(),
        execution,
        outcome: { type: "completed" },
        recordAuditEvent: noAudit,
        responseMessage: toPersistableChatMessage({
          id: assistantMessageId,
          parts: [TEXT_PART],
          role: "assistant",
        }),
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
        indexThread: async () => {},
      }),
    );
    const before = await readTurn(turnId);

    expect(await stop({ threadId, turnId })).toEqual({
      body: { turn: { id: turnId, status: "completed" } },
      status: 200,
    });
    expect(await readTurn(turnId)).toEqual(before);
  });

  test("finds no turn outside the thread, unknown, or another user's", async () => {
    const { threadId, turnId } = await seedRunningTurn();
    const other = await seedAcceptedTurn();
    const notFound = {
      body: expect.objectContaining({ message: "Chat turn not found" }),
      status: 404,
    };

    expect(await stop({ threadId, turnId: other.turnId })).toEqual(notFound);
    expect(
      await stop({
        threadId,
        turnId: toSafeId<"chatTurn">(Bun.randomUUIDv7()),
      }),
    ).toEqual(notFound);
    expect(await stop({ as: otherUserSafeDb, threadId, turnId })).toEqual(
      notFound,
    );
    // None of them touched a turn.
    expect((await readTurn(turnId)).cancelRequestedAt).toBeNull();
    expect((await readTurn(other.turnId)).status).toBe("accepted");
  });

  test("records a stop on a running turn once, and its owner elsewhere settles it", async () => {
    const { threadId, turnId } = await seedRunningTurn();

    expect(await stop({ threadId, turnId })).toEqual({
      body: { turn: { id: turnId, status: "running" } },
      status: 202,
    });
    const first = (await readTurn(turnId)).cancelRequestedAt;
    expect(first).not.toBeNull();
    await Bun.sleep(5);
    expect((await stop({ threadId, turnId })).status).toBe(202);
    expect((await readTurn(turnId)).cancelRequestedAt).toEqual(first);
  });

  test("aborts a run this process produces and answers once it is settled", async () => {
    const { execution, threadId, turnId } = await seedRunningTurn();
    const abortController = new AbortController();
    const producer = registerChatTurnProducer({
      abortController,
      execution,
      safeDb,
    });
    // The owner: a stopped run stores the stop, as `streamChat` does.
    abortController.signal.addEventListener(
      "abort",
      () => {
        void persistInterruptedChatTurn({
          execution,
          recordAuditEvent: noAudit,
          safeDb,
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        }).then(producer.settled);
      },
      { once: true },
    );

    expect(await stop({ threadId, turnId })).toEqual({
      body: { turn: { id: turnId, reason: "user-stop", status: "cancelled" } },
      status: 200,
    });
    expect(abortController.signal.reason).toBe(RUN_CANCEL_REASON);
  });

  test("an owner on another instance finds the stop at its renewal and its poll", async () => {
    const { execution, threadId, turnId } = await seedRunningTurn();
    expect(
      unwrap(await renewChatTurnExecutionLease({ execution, safeDb })),
    ).toBe("owned");
    const abortController = new AbortController();
    const producer = registerChatTurnProducer({
      abortController,
      execution,
      pollMs: 5,
      safeDb,
    });
    try {
      // Recorded as another instance's endpoint records it: no local abort.
      expect((await recordStop({ threadId, turnId })).type).toBe("requested");
      expect(
        unwrap(await renewChatTurnExecutionLease({ execution, safeDb })),
      ).toBe("stop-requested");
      for (
        let poll = 0;
        poll < 400 && !abortController.signal.aborted;
        poll += 1
      ) {
        await Bun.sleep(5);
      }
      expect(abortController.signal.reason).toBe(RUN_CANCEL_REASON);
    } finally {
      producer.settled();
    }
  });
});

type OwnerEnd = {
  label: string;
  settle: (props: {
    execution: ChatTurnExecution;
    threadId: SafeId<"chatThread">;
  }) => Promise<Result<unknown, unknown>>;
};

const finalizeAs =
  (outcome: ChatTurnOutcome, parts: ChatPart[]): OwnerEnd["settle"] =>
  async ({ execution, threadId }) =>
    await finalizeAssistantTurn({
      acceptedSendMode: null,
      existingIds: new Set(),
      execution,
      outcome,
      recordAuditEvent: noAudit,
      responseMessage: toPersistableChatMessage({
        id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
        parts,
        role: "assistant",
      }),
      safeDb,
      threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
      indexThread: async () => {},
    });

/** Every way an owner ends a running turn. */
const OWNER_ENDS: OwnerEnd[] = [
  {
    label: "completes",
    settle: finalizeAs({ type: "completed" }, [TEXT_PART]),
  },
  {
    label: "waits on an approval",
    settle: finalizeAs(
      {
        interaction: { toolCallId: APPROVAL_CALL.id, type: "approval" },
        type: "awaiting-user",
      },
      [TEXT_PART, APPROVAL_CALL],
    ),
  },
  {
    label: "fails in the stream",
    settle: finalizeAs({ error: "provider_unavailable", type: "failed" }, [
      TEXT_PART,
    ]),
  },
  {
    label: "loses its connection",
    settle: finalizeAs({ reason: "client-disconnected", type: "interrupted" }, [
      TEXT_PART,
    ]),
  },
  {
    label: "fails before streaming",
    settle: async ({ execution, threadId }) =>
      await persistFailedChatTurn({
        code: "internal",
        execution,
        recordAuditEvent: noAudit,
        retryable: true,
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      }),
  },
  {
    label: "is disconnected before streaming",
    settle: async ({ execution, threadId }) =>
      await persistInterruptedChatTurn({
        execution,
        recordAuditEvent: noAudit,
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      }),
  },
];

describe("a running turn's owner, once the user asked to stop", () => {
  test.each(OWNER_ENDS)(
    "stores the stop when it $label",
    async ({ settle }) => {
      const { execution, threadId, turnId } = await seedRunningTurn();
      expect((await recordStop({ threadId, turnId })).type).toBe("requested");

      unwrap(await settle({ execution, threadId }));

      const row = await readTurn(turnId);
      expect({ reason: row.cancellationReason, status: row.status }).toEqual({
        reason: "user-stop",
        status: "cancelled",
      });
      expect(await findTurnOutcomeMismatches({ db: testDb, threadId })).toEqual(
        [],
      );
      // Nothing the turn stopped on is offered again.
      expect(await findOfferedInteractions({ db: testDb, threadId })).toEqual(
        [],
      );
      const stored = (
        await testDb.query.chatMessages.findMany({
          where: { threadId: { eq: threadId }, role: { eq: "assistant" } },
          columns: { content: true, id: true, role: true },
        })
      ).map(chatMessageFromPersisted);
      expect(stored.map(({ metadata }) => metadata?.turnOutcome)).toEqual([
        USER_STOP,
      ]);
      expect(
        stored
          .flatMap(({ parts }) => parts)
          .filter(
            (part) =>
              part.type === "tool-call" && part.state === "approval-requested",
          ),
      ).toEqual([]);
    },
  );

  /**
   * Five stops and the owner's finish, the finish starting after `stopsFirst`
   * of the stops. Returns how the turn ended once they all have.
   */
  const raceStopsWithFinish = async (stopsFirst: number) => {
    const { execution, threadId, turnId } = await seedRunningTurn();
    const messageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const finish = async () =>
      await finalizeAssistantTurn({
        acceptedSendMode: null,
        existingIds: new Set(),
        execution,
        outcome: { type: "completed" },
        recordAuditEvent: createBackgroundAuditRecorder({
          execution: {
            performer: { id: ids.userA1, type: "user" },
            trigger: { type: "direct" },
          },
          organizationId: ids.orgA,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        }),
        responseMessage: toPersistableChatMessage({
          id: messageId,
          parts: [TEXT_PART],
          role: "assistant",
        }),
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
        indexThread: async () => {},
      });
    const racers = Array.from({ length: 6 }, (_, index) =>
      index === stopsFirst
        ? async () => await finish()
        : async () => await stop({ threadId, turnId }),
    );
    await Promise.all(racers.map(async (run) => await run()));

    const row = await readTurn(turnId);
    // Exactly one outcome: the finish, or the stop that overtook it.
    expect(["cancelled", "completed"]).toContain(row.status);
    expect(await findTurnOutcomeMismatches({ db: testDb, threadId })).toEqual(
      [],
    );
    // One stored message, audited once; a stop audits nothing.
    expect(
      await testDb
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, messageId)),
    ).toHaveLength(1);
    // A later stop reports the outcome and never moves the first time.
    expect((await stop({ threadId, turnId })).status).toBe(200);
    const after = await readTurn(turnId);
    expect({
      requested: after.cancelRequestedAt,
      status: after.status,
    }).toEqual({ requested: row.cancelRequestedAt, status: row.status });
    return row.status;
  };

  test("settles once when stops race its finish", async () => {
    const outcomes = new Set<string>();
    for (const stopsFirst of [0, 1, 3, 5]) {
      outcomes.add(await raceStopsWithFinish(stopsFirst));
    }
    // The fixture must reach both orders.
    expect([...outcomes].toSorted()).toEqual(["cancelled", "completed"]);
  });
});

describe("the thread a stopped turn belongs to", () => {
  test("keeps its other turns out of a late stop", async () => {
    const { threadId, turnId } = await seedAwaitingTurn();
    expect((await stop({ threadId, turnId })).status).toBe(200);
    // A new message starts the thread's next turn.
    const next = createChatTurnAcceptance({
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      userMessageId: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
      workspaceId: ids.wsA1,
    });
    unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values({
          content: { data: [{ text: "Next", type: "text" }], version: 1 },
          id: next.userMessageId,
          role: "user",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
        expect(
          await insertChatTurnAcceptanceOnTx({ acceptance: next, tx }),
        ).toMatchObject({ type: "accepted" });
      }),
    );

    expect((await stop({ threadId, turnId })).body).toEqual({
      turn: { id: turnId, reason: "user-stop", status: "cancelled" },
    });
    const nextRow = await readTurn(next.id);
    expect({
      requested: nextRow.cancelRequestedAt,
      status: nextRow.status,
    }).toEqual({ requested: null, status: "accepted" });
    expect(
      await testDb
        .select({ id: chatTurns.id })
        .from(chatTurns)
        .where(eq(chatTurns.threadId, threadId)),
    ).toHaveLength(2);
  });
});

/** `error` and every error it was caused by. */
const causesOf = (error: unknown): object[] => {
  const causes: object[] = [];
  let current = error;
  while (
    typeof current === "object" &&
    current !== null &&
    !causes.includes(current)
  ) {
    causes.push(current);
    current = Reflect.get(current, "cause");
  }
  return causes;
};

describe("a page's client call once the turn was stopped", () => {
  test("is refused by the server and changes nothing it stored", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);
    const stopping = await harness.openWebClient(threadId);
    try {
      harness.script(threadId, [
        {
          toolCalls: [
            {
              arguments: CLIENT_CALL.arguments,
              toolCallId: CLIENT_CALL.id,
              toolName: CREATE_DOCUMENT_TOOL_NAME,
            },
          ],
          type: "step",
        },
      ]);
      await stopping.sendUserMessage(Bun.randomUUIDv7(), "Draft the NDA");
      // A second tab, loaded while the page still runs the call.
      const late = await harness.openWebClient(threadId);
      try {
        await stopping.stop();
        const stored = await harness.readThreadMessages(threadId);
        // The fixture must reach the fault: the late tab still shows the call.
        expect(
          late
            .messages()
            .flatMap(({ parts }) => parts)
            .some(
              (part) => part.type === "tool-call" && part.id === CLIENT_CALL.id,
            ),
        ).toBe(true);

        await late.runClientTool(CLIENT_CALL.id, CREATE_DOCUMENT_TOOL_NAME, {
          destination: "download",
          fileName: "NDA.docx",
          success: true,
        } satisfies CreateDocumentToolOutput);

        // Refused: the stopped message no longer awaits the call, and a turn
        // claimed before the stop no longer owns it; however the page wraps
        // the refusal.
        const refusals = new Set<unknown>([
          CHAT_CONTINUATION_REJECTED_ERROR_CODE,
          CHAT_TURN_NOT_OWNED_ERROR_CODE,
        ]);
        expect(
          late
            .takeErrors()
            .some((error) =>
              causesOf(error).some((cause) =>
                refusals.has(Reflect.get(cause, "code")),
              ),
            ),
        ).toBe(true);
        expect(await harness.readThreadMessages(threadId)).toEqual(stored);
        // The stored thread holds every invariant after the refusal.
        const storedOracles = new Set<string>([
          CHAT_ORACLE.persistedCallsSettled,
          CHAT_ORACLE.persistedPendingOwned,
          CHAT_ORACLE.persistedTurnOutcome,
          CHAT_ORACLE.persistedTurnSettles,
          CHAT_ORACLE.providerScriptsConsumed,
        ]);
        expect(
          (
            await harness.checkWebClient({
              client: late,
              expected: { refusal: true },
              threadId,
            })
          ).filter(({ oracle }) => storedOracles.has(oracle)),
        ).toEqual([]);
      } finally {
        late.dispose();
      }
      await harness.expectSoundWebClient({ client: stopping, threadId });
    } finally {
      stopping.dispose();
      harness.close();
    }
  });
});
