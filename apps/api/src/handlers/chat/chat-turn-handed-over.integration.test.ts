import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
  toPersistableChatMessage,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import {
  claimChatTurnForExecution,
  createChatTurnAcceptance,
  insertChatTurnAcceptanceOnTx,
  OWNER_LOST_OUTCOME,
  reapOwnerlessChatTurnOnTx,
} from "@/api/handlers/chat/chat-turn-persistence";
import cancelTurn from "@/api/handlers/chat/turns/cancel";
import steerTurn from "@/api/handlers/chat/turns/steer";
import type { ChatPart } from "@/api/handlers/chat/types";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withChatRunPings } from "@/api/lib/chat/chat-run-pings";
import { CHAT_TURN_RUN_ENDING_STATUSES } from "@/api/lib/chat/turn-status";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { findTurnOutcomeMismatches } from "@/api/tests/helpers/chat-thread-invariants";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// A turn its owner handed over (`handed-over`): the answer so far is stored,
// nobody owns it, and another task is to adopt it by its lease. Nothing in
// this release produces the status, so each case builds it from a running
// turn by hand, and checks what every other writer does with it.

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

const TEXT_PART = {
  content: "Reading the repository.",
  type: "text",
} satisfies ChatPart;
/** A call the computer was still running when the turn was released. */
const OPEN_CALL = {
  arguments: JSON.stringify({ command: "ls" }),
  id: "call-shell",
  input: { command: "ls" },
  name: "shell",
  state: "input-complete",
  type: "tool-call",
  metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
} satisfies ChatPart;

const acceptOnThread = async ({
  threadId,
  userMessageId,
}: {
  threadId: SafeId<"chatThread">;
  userMessageId: SafeId<"chatMessage">;
}) => {
  const acceptance = createChatTurnAcceptance({
    source: { type: "member" },
    organizationId: ids.orgA,
    threadId,
    userId: ids.userA1,
    userMessageId,
    workspaceId: ids.wsA1,
  });
  const accepted = unwrap(
    await withChatRunPings(
      async (pings) =>
        await safeDb(async (tx) => {
          await tx.insert(chatMessages).values({
            content: toPersistedChatMessageContentV3({
              data: [{ content: "Go on", type: "text" }],
            }),
            id: userMessageId,
            role: "user",
            threadId,
            userId: ids.userA1,
            workspaceId: ids.wsA1,
          });
          return await insertChatTurnAcceptanceOnTx({ pings, acceptance, tx });
        }),
    ),
  );
  return { accepted, turnId: acceptance.id };
};

/**
 * A running turn released by its owner: its answer so far (with a call still
 * open on the computer) stored as the turn's message, adopt-by `adoptBy`.
 */
const seedHandedOverTurn = async ({
  adoptBy = sql<Date>`now() + interval '90 seconds'`,
}: { adoptBy?: SQL<Date> } = {}) => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  const userMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Hand-over test",
    userId: ids.userA1,
    workspaceId: ids.wsA1,
  });
  const { accepted, turnId } = await acceptOnThread({
    threadId,
    userMessageId,
  });
  expect(accepted.type).toBe("accepted");
  const execution = unwrap(
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
  );
  expect(execution).not.toBeNull();
  const assistantMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  const checkpoint = toPersistableChatMessage({
    id: assistantMessageId,
    parts: [TEXT_PART, OPEN_CALL],
    role: "assistant",
  });
  await testDb.insert(chatMessages).values({
    content: chatMessageContentFromMessage(checkpoint),
    id: assistantMessageId,
    role: "assistant",
    threadId,
    userId: ids.userA1,
    workspaceId: ids.wsA1,
  });
  // The lease must stay after the turn's creation, so a lapsed adopt-by
  // moves the creation back too.
  await testDb
    .update(chatTurns)
    .set({
      assistantMessageId,
      createdAt: sql`now() - interval '1 hour'`,
      executionId: null,
      leaseExpiresAt: adoptBy,
      status: "handed-over",
    })
    .where(eq(chatTurns.id, turnId));
  return { assistantMessageId, threadId, turnId, userMessageId };
};

const LAPSED = sql<Date>`now() - interval '1 second'`;

/** One reaper visit to `threadId`, as the scheduled task makes it. */
const reapThread = async (threadId: SafeId<"chatThread">) =>
  await withChatRunPings(
    async (pings) =>
      await testDb.transaction(
        async (tx) => await reapOwnerlessChatTurnOnTx({ pings, threadId, tx }),
      ),
  );

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

/** Call a turn route as the page does; answers the handler's body. */
const callTurnRoute = async ({
  body,
  handler,
  path,
  threadId,
  turnId,
}: {
  body?: unknown;
  handler: (context: never) => unknown;
  path: "cancel" | "steer";
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
}): Promise<unknown> =>
  await handler(
    asTestRaw<never>({
      body,
      memberRole: sessionMemberRole("owner"),
      params: { threadId, turnId },
      request: new Request(
        `http://localhost/v1/chat/threads/${threadId}/turns/${turnId}/${path}`,
        { method: path === "cancel" ? "POST" : "PATCH" },
      ),
      route: (path === "cancel"
        ? "/v1/chat/threads/:threadId/turns/:turnId/cancel"
        : "/v1/chat/threads/:threadId/turns/:turnId/steer") satisfies ApiRoutePath,
      safeDb,
      session: { activeOrganizationId: ids.orgA },
      set: { headers: {}, status: 200 },
      user: { id: ids.userA1 },
    }),
  );

describe("a handed-over chat turn", () => {
  test("a stop ends it at once, its stored answer with it", async () => {
    const { assistantMessageId, threadId, turnId } = await seedHandedOverTurn();

    expect(
      await callTurnRoute({
        handler: cancelTurn.handler,
        path: "cancel",
        threadId,
        turnId,
      }),
    ).toEqual({
      turn: { id: turnId, reason: "user-stop", status: "cancelled" },
    });
    const turn = await readTurn(turnId);
    expect(turn.status).toBe("cancelled");
    expect(turn.assistantMessageId).toBeNull();
    // Its run, still open on the computer, is the gateway sweep's to cancel:
    // a cancelled turn no longer holds it.
    expect(CHAT_TURN_RUN_ENDING_STATUSES).toContain(turn.status);
    const message = await readMessage(assistantMessageId);
    expect(message.metadata?.turnOutcome).toEqual({
      reason: "user-stop",
      type: "cancelled",
    });
    // The call the computer was running is closed with the turn.
    expect(message.parts.at(0)).toEqual(TEXT_PART);
    expect(
      message.parts.some(
        (part) => part.type === "tool-call" && part.state === "input-complete",
      ),
    ).toBe(false);
    expect(await findTurnOutcomeMismatches({ db: testDb, threadId })).toEqual(
      [],
    );
  });

  test("a new message is refused before its adopt-by time", async () => {
    const { threadId, turnId } = await seedHandedOverTurn();

    const { accepted } = await acceptOnThread({
      threadId,
      userMessageId: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
    });

    expect(accepted.type).toBe("refused");
    expect((await readTurn(turnId)).status).toBe("handed-over");
  });

  test("a new message after its adopt-by time ends it as owner-lost", async () => {
    const { assistantMessageId, threadId, turnId } = await seedHandedOverTurn({
      adoptBy: LAPSED,
    });

    const { accepted } = await acceptOnThread({
      threadId,
      userMessageId: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
    });

    expect(accepted.type).toBe("accepted");
    const turn = await readTurn(turnId);
    expect(turn.status).toBe("interrupted");
    expect(turn.interruptionReason).toBe("owner-lost");
    expect(
      (await readMessage(assistantMessageId)).metadata?.turnOutcome,
    ).toEqual(OWNER_LOST_OUTCOME);
  });

  test("the reaper ends one nobody adopted, and leaves one still due alone", async () => {
    const lapsed = await seedHandedOverTurn({ adoptBy: LAPSED });
    const due = await seedHandedOverTurn();

    for (const { threadId } of [lapsed, due]) {
      await reapThread(threadId);
    }

    const ended = await readTurn(lapsed.turnId);
    expect(ended.status).toBe("interrupted");
    expect(ended.interruptionReason).toBe("owner-lost");
    expect(ended.executionId).toBeNull();
    // The outcome goes on the stored answer although it is the turn's own
    // message, not a continuation's.
    const message = await readMessage(lapsed.assistantMessageId);
    expect(message.metadata?.turnOutcome).toEqual(OWNER_LOST_OUTCOME);
    expect(
      await findTurnOutcomeMismatches({
        db: testDb,
        threadId: lapsed.threadId,
      }),
    ).toEqual([]);
    expect((await readTurn(due.turnId)).status).toBe("handed-over");
  });

  test("a steer is refused as the turn is not running", async () => {
    const { threadId, turnId } = await seedHandedOverTurn();

    expect(
      await callTurnRoute({
        body: { inputId: Bun.randomUUIDv7(), text: "Also check the tests" },
        handler: steerTurn.handler,
        path: "steer",
        threadId,
        turnId,
      }),
    ).toEqual({ steer: { type: "refused", reason: "turn_not_running" } });
  });
});
