import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { session } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import {
  claimChatTurnForExecution,
  createChatTurnAcceptance,
  insertChatTurnAcceptanceOnTx,
  settleChatTurnOnTx,
  startChatTurnRun,
} from "@/api/handlers/chat/chat-turn-persistence";
import { chatRoute } from "@/api/handlers/chat/routes";
import { createHttpApp } from "@/api/http/app";
import { getAuth, realtimeAuthorizers } from "@/api/lib/auth";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createChatRunLog } from "@/api/lib/chat/run-log";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { sweepBoundStreams } from "@/api/lib/sse";
import { signInHuman } from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import { serveForTest } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// A chat turn keeps running while the session of the device watching it ends:
// another device signs it out, or it expires. The real chat routes served over
// HTTP with their member authentication, the real revocation endpoint, and a
// run log written the way a
// producing turn writes it. The ended session can neither probe nor rejoin
// the turn, nobody else in the organization can either, and the turn still
// runs to its settlement for the owner's live session.

setDefaultTimeout(120_000);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
});

const server = serveForTest(
  createHttpApp({ routes: chatRoute, middleware: [errorBoundary] }),
);

afterAll(async () => {
  await server.stop();
  await releaseAgentAuthTestDb();
});

const BASE = "http://localhost";

/**
 * The device's cookies once its signed session snapshot has lapsed. The
 * snapshot is accepted without a storage read for its own short lifetime
 * (`SESSION_COOKIE_CACHE_MAX_AGE_SECONDS`), the documented bound on a revoked
 * credential; past it every request reads the live session.
 */
const withoutSessionSnapshot = (browser: HumanBrowser): string => {
  const cookie = browser
    .cookieHeader()
    .split("; ")
    .filter((pair) => !pair.includes("session_data="))
    .join("; ");
  expect(cookie).not.toBe(browser.cookieHeader());
  return cookie;
};

type Turn = {
  organizationId: SafeId<"organization">;
  owner: SafeId<"user">;
  runId: string;
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
};

const turnRequest = async (
  turn: Turn,
  action: "join" | "resume",
  cookie: string,
): Promise<Response> =>
  await server.fetch(
    new Request(
      `${BASE}/chat/threads/${turn.threadId}/turns/${turn.turnId}/${action}?runId=${turn.runId}`,
      { headers: { cookie } },
    ),
  );

const ownerDb = (turn: Pick<Turn, "organizationId" | "owner">) =>
  asTestRaw<ScopedDb>(
    createScopedDb(testDb, [], turn.organizationId, turn.owner),
  );

const textChunk = (messageId: string, delta: string): StreamChunk => ({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId,
  delta,
});

type Fixture = {
  /** The device whose session ends while the turn runs. */
  leaving: HumanBrowser;
  /** The same person on another device, still signed in. */
  staying: HumanBrowser;
  /** Another member of the same organization. */
  colleague: HumanBrowser;
  turn: Turn;
  log: ReturnType<typeof createChatRunLog>;
  settle: () => Promise<void>;
};

/** One person signed in on two devices, a colleague, and a running turn in
 *  the person's own chat with part of its answer already in the run log. */
const createRunningTurn = async (): Promise<Fixture> => {
  const auth = getAuth();
  const email = `chat-session-${Bun.randomUUIDv7()}@stella.dev`;
  const leaving = await signInHuman(email);
  const organization = await auth.api.createOrganization({
    body: {
      name: "Chat session",
      slug: `chat-session-${Bun.randomUUIDv7()}`,
    },
    headers: leaving.headers(),
  });
  await leaving.setActiveOrganization(organization.id);
  const staying = await signInHuman(email);
  await staying.setActiveOrganization(organization.id);

  const colleague = await signInHuman(
    `chat-colleague-${Bun.randomUUIDv7()}@stella.dev`,
  );
  const invitation = await auth.api.createInvitation({
    body: {
      email: colleague.email,
      role: "member",
      organizationId: organization.id,
    },
    headers: leaving.headers(),
  });
  await auth.api.acceptInvitation({
    body: { invitationId: invitation.id },
    headers: colleague.headers(),
  });
  await colleague.setActiveOrganization(organization.id);

  const organizationId = brandPersistedOrganizationId(organization.id);
  const owner = brandPersistedUserId(leaving.userId);
  const threadId = createSafeId<"chatThread">();
  const userMessageId = createSafeId<"chatMessage">();
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId,
    title: "Lease summary",
    userId: owner,
    workspaceId: null,
  });
  await testDb.insert(chatMessages).values({
    id: userMessageId,
    threadId,
    userId: owner,
    workspaceId: null,
    role: "user",
    content: toPersistedChatMessageContentV3({
      data: [{ content: "Summarise the lease", type: "text" }],
    }),
  });
  const db = ownerDb({ organizationId, owner });
  const safeDb = toSafeDbMock(db);
  const acceptance = createChatTurnAcceptance({
    organizationId,
    threadId,
    userId: owner,
    userMessageId,
    workspaceId: null,
  });
  unwrap(
    await safeDb(
      async (tx) => await insertChatTurnAcceptanceOnTx({ acceptance, tx }),
    ),
  );
  const execution =
    unwrap(
      await claimChatTurnForExecution({
        acceptedTurnId: acceptance.id,
        incomingMessageId: userMessageId,
        incomingMessageRole: "user",
        organizationId,
        safeDb,
        threadId,
        userId: owner,
        workspaceId: null,
      }),
    ) ?? panic("Expected the turn to be claimed");
  const runId = Bun.randomUUIDv7();
  expect(unwrap(await startChatTurnRun({ execution, runId, safeDb }))).toBe(
    "owned",
  );
  const log = createChatRunLog({ db, execution, organizationId, runId });
  await log.append([
    { type: EventType.RUN_STARTED, threadId, runId },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "answer",
      role: "assistant",
    },
    textChunk("answer", "The lease runs"),
  ]);
  const settle = async () => {
    await log.append([
      textChunk("answer", " until 2031."),
      { type: EventType.TEXT_MESSAGE_END, messageId: "answer" },
      { type: EventType.RUN_FINISHED, threadId, runId, finishReason: "stop" },
    ]);
    await log.close();
    const assistantMessageId = createSafeId<"chatMessage">();
    const settled = unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values({
          content: toPersistedChatMessageContentV3({
            data: [{ content: "The lease runs until 2031.", type: "text" }],
            metadata: { turnOutcome: { type: "completed" } },
          }),
          id: assistantMessageId,
          role: "assistant",
          threadId,
          userId: owner,
          workspaceId: null,
        });
        return await settleChatTurnOnTx({
          assistantMessageId,
          execution,
          outcome: { type: "completed" },
          tx,
        });
      }),
    );
    expect(settled).not.toBe("not-owned");
  };
  return {
    leaving,
    staying,
    colleague,
    turn: { organizationId, owner, runId, threadId, turnId: execution.id },
    log,
    settle,
  };
};

const unwrap = <T, E>(result: Result<T, E>): T =>
  Result.isError(result)
    ? panic("Unexpected failure", result.error)
    : result.value;

/** Read a live join stream until `text` has arrived, then let it go. */
const readJoinUntil = async (response: Response, text: string) => {
  const { body } = response;
  if (!body) {
    return panic("The join stream has no body");
  }
  const decoder = new TextDecoder();
  let received = "";
  const reader = body.getReader();
  try {
    while (!received.includes(text)) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += decoder.decode(value, { stream: true });
    }
  } finally {
    // swallow-ok: the join stream is still open; cancelling only detaches it
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return received;
};

/** The reader of a join stream the test holds open; the caller releases it. */
const joinReader = (response: Response) => {
  const body = response.body ?? panic("The join stream has no body");
  const reader = body.getReader();
  return reader;
};

/** A join stream held open: read as far as a text, or to its end. */
const holdJoin = (reader: ReturnType<typeof joinReader>) => {
  const decoder = new TextDecoder();
  let received = "";
  const readUntil = async (text: string): Promise<"ended" | "received"> => {
    while (!received.includes(text)) {
      const { done, value } = await reader.read();
      if (done) {
        return "ended";
      }
      received += decoder.decode(value, { stream: true });
    }
    return "received";
  };
  return { readUntil, received: () => received };
};

/** A refusal must not carry any of the turn: no stream, no answer text. */
const expectRefusal = async (response: Response, status: number) => {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type") ?? "").not.toContain(
    "text/event-stream",
  );
  const body = await response.text();
  expect(body).not.toContain("The lease runs");
  expect(body).not.toContain("running");
};

const endings = {
  /** The person signs this device out from their other device. */
  revoked: async ({ staying }: Fixture) => {
    const auth = getAuth();
    await auth.api.revokeOtherSessions({ headers: staying.headers() });
  },
  /** The device's session reaches its deadline. */
  expired: async ({ leaving }: Fixture) => {
    const auth = getAuth();
    const current =
      (await auth.api.getSession({ headers: leaving.headers() })) ??
      panic("Expected the leaving device to be signed in");
    await rootDb
      .update(session)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(session.id, current.session.id));
  },
} satisfies Record<string, (fixture: Fixture) => Promise<void>>;

describe("a running chat turn whose watching session ends", () => {
  for (const [ending, endSession] of Object.entries(endings)) {
    test(`a ${ending} session can no longer probe or rejoin, and the turn settles for the owner`, async () => {
      const fixture = await createRunningTurn();
      const { colleague, leaving, staying, turn } = fixture;

      // While signed in, the device sees its running turn and rejoins it.
      const probe = await turnRequest(turn, "resume", leaving.cookieHeader());
      expect(probe.status).toBe(200);
      expect(await probe.json()).toEqual({
        type: "running",
        turnId: turn.turnId,
        runId: turn.runId,
      });
      const join = await turnRequest(turn, "join", leaving.cookieHeader());
      expect(join.status).toBe(200);
      expect(await readJoinUntil(join, "The lease runs")).toContain(
        "The lease runs",
      );

      await endSession(fixture);

      // The fixture reaches the fault: the device's own cookies no longer
      // name a session.
      expect(
        await getAuth().api.getSession({
          headers: new Headers({ cookie: withoutSessionSnapshot(leaving) }),
        }),
      ).toBeNull();
      const ended = withoutSessionSnapshot(leaving);
      await expectRefusal(await turnRequest(turn, "resume", ended), 401);
      await expectRefusal(await turnRequest(turn, "join", ended), 401);

      // Nobody else in the organization reaches the turn either: the same
      // answer as for a turn that never existed.
      await expectRefusal(
        await turnRequest(turn, "resume", colleague.cookieHeader()),
        404,
      );
      await expectRefusal(
        await turnRequest(turn, "join", colleague.cookieHeader()),
        404,
      );

      // The turn did not depend on the device that left: the owner's live
      // session still follows it, and it settles.
      const stillRunning = await turnRequest(
        turn,
        "resume",
        staying.cookieHeader(),
      );
      expect(await stillRunning.json()).toMatchObject({ type: "running" });
      await fixture.settle();
      const settled = await turnRequest(turn, "resume", staying.cookieHeader());
      expect(settled.status).toBe(200);
      expect(await settled.json()).toEqual({
        type: "transcript",
        turnId: turn.turnId,
      });
      // And the ended session still learns nothing about how it ended.
      await expectRefusal(await turnRequest(turn, "resume", ended), 401);
    });

    test(`a join stream the ${ending} session already holds ends at the next credential sweep, while the owner's other device keeps the answer`, async () => {
      const fixture = await createRunningTurn();
      const { leaving, staying, turn } = fixture;
      const leavingReader = joinReader(
        await turnRequest(turn, "join", leaving.cookieHeader()),
      );
      const stayingReader = joinReader(
        await turnRequest(turn, "join", staying.cookieHeader()),
      );
      try {
        const leavingJoin = holdJoin(leavingReader);
        const stayingJoin = holdJoin(stayingReader);
        expect(await leavingJoin.readUntil("The lease runs")).toBe("received");
        expect(await stayingJoin.readUntil("The lease runs")).toBe("received");

        await endSession(fixture);
        await sweepBoundStreams(realtimeAuthorizers.sessions);

        // The stream that was already open ends with its session, before the
        // rest of the answer exists.
        expect(await leavingJoin.readUntil(" until 2031.")).toBe("ended");
        await fixture.settle();
        expect(leavingJoin.received()).not.toContain(" until 2031.");
        // The same person's live device follows the turn to its end.
        expect(await stayingJoin.readUntil(" until 2031.")).toBe("received");
      } finally {
        // swallow-ok: a stream the test held open; cancelling only detaches it
        await leavingReader.cancel().catch(() => undefined);
        // swallow-ok: a stream the test held open; cancelling only detaches it
        await stayingReader.cancel().catch(() => undefined);
        leavingReader.releaseLock();
        stayingReader.releaseLock();
      }
    });
  }
});
