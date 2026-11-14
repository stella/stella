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
import fc from "fast-check";

import { chatThreadsChangedRealtimeEvent } from "@stll/api-contract";
import type { UserRealtimeEvent } from "@stll/api-contract";
import {
  CHAT_THREAD_PIN_STATE,
  CHAT_THREAD_READ_STATE,
} from "@stll/api-contract/chat";
import type {
  ChatThreadPinState,
  ChatThreadReadState,
} from "@stll/api-contract/chat";
import { assertProperty, propertyConfig } from "@stll/property-testing";

import type { ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { WithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-projection";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import * as sseModule from "@/api/lib/sse";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { seedChatTurns } from "@/api/tests/read-scaling/chat-active-runs";
import {
  chatPinnedThreadsScalingScenario,
  PINNED_THREADS_PAGE,
  seedChatThreadsScaling,
} from "@/api/tests/read-scaling/chat-threads";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { createGetThreads } from "./list";
import updateChatThreadPinState from "./pin-state/update";
import updateChatThreadReadState from "./read-state/update";

// A chat's per-reader states in the chats list: unread while its latest
// answer settled after the reader last had it open, and pinned on request.
// Only the thread's own reader, in the thread's own scope, can change them.

type ListCtx = Parameters<ReturnType<typeof createGetThreads>["handler"]>[0];
type ReadCtx = Parameters<typeof updateChatThreadReadState.handler>[0];
type PinCtx = Parameters<typeof updateChatThreadPinState.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

const cleanUp = async () => {
  for (const cleanup of cleanups.splice(0)) {
    // db-await-in-loop: one delete per seeded batch, a handful per test
    await cleanup();
  }
};

type Ping = {
  event: UserRealtimeEvent;
  organizationId: string;
  userId: string;
};

/** Every user broadcast sent since the test began. */
const pings: Ping[] = [];

/** The pings sent since the last call, in order. */
const takePings = (): Ping[] => pings.splice(0);

beforeEach(() => {
  pings.length = 0;
  spyOn(sseModule, "broadcastToUser").mockImplementation(
    (userId, organizationId, event) => {
      pings.push({ event, organizationId, userId });
    },
  );
});

afterEach(async () => {
  mock.restore();
  await cleanUp();
});

afterAll(async () => {
  await cleanUp();
  await releaseRlsFixture();
});

const getThreads = createGetThreads({
  readCopies: async () => new WithdrawnCopyProjection([], "Withdrawn"),
  // No seeded thread is about a decision.
  readDecisionBadges: async () => Result.ok(new Map()),
});

const BASE_MS = Date.parse("2026-10-02T08:00:00.000Z");
const at = (seconds: number) => new Date(BASE_MS + seconds * 1000);
/** seedChatTurns settles a settled turn one second after it was created. */
const SETTLE_DELAY_S = 1;

type Caller = {
  userId: SafeId<"user">;
  workspaceIds: SafeId<"workspace">[];
};

const callerOf = (overrides: Partial<Caller> = {}): Caller => ({
  userId: overrides.userId ?? ids.userA1,
  workspaceIds: overrides.workspaceIds ?? [ids.wsA1, ids.wsA2],
});

const contextOf = (caller: Caller) => ({
  getWorkspaceAccess: async (workspaceId: SafeId<"workspace">) =>
    caller.workspaceIds.includes(workspaceId)
      ? { id: workspaceId, status: "active" as const }
      : null,
  memberRole: sessionMemberRole("member"),
  safeDb: toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, caller.workspaceIds, ids.orgA, caller.userId),
    ),
  ),
  session: { activeOrganizationId: ids.orgA },
  user: { id: caller.userId },
});

/** One completed thread of the reader's, answered at `at(seconds + 1)`. */
const seedAnsweredThread = async ({
  createdAtSeconds = 0,
  title,
  workspaceId = null,
}: {
  createdAtSeconds?: number;
  title: string;
  workspaceId?: SafeId<"workspace"> | null;
}): Promise<SafeId<"chatThread">> => {
  const seeded = await seedChatTurns(testDb, [
    {
      createdAt: at(createdAtSeconds),
      organizationId: ids.orgA,
      status: "completed",
      title,
      userId: ids.userA1,
      workspaceId,
    },
  ]);
  cleanups.push(seeded.cleanup);
  const threadId = seeded.threadIds.at(0) ?? panic("one thread was seeded");
  // Recently active in seed order, so the list's order is the seed's.
  await testDb
    .update(chatThreads)
    .set({ updatedAt: at(createdAtSeconds) })
    .where(eq(chatThreads.id, threadId));
  return threadId;
};

const setLastReadAt = async (
  threadId: SafeId<"chatThread">,
  lastReadAt: Date | null,
) => {
  await testDb
    .update(chatThreads)
    .set({ lastReadAt, updatedAt: sql`${chatThreads.updatedAt}` })
    .where(eq(chatThreads.id, threadId));
};

/** A later turn on the thread that was stopped before it answered. */
const appendCancelledTurn = async (
  threadId: SafeId<"chatThread">,
  createdAt: Date,
) => {
  const userMessageId = createSafeId<"chatMessage">();
  await testDb.insert(chatMessages).values({
    content: toPersistedChatMessageContentV3({
      data: [{ content: "And then?", type: "text" }],
    }),
    createdAt,
    id: userMessageId,
    role: "user",
    threadId,
    userId: ids.userA1,
    workspaceId: null,
  });
  await testDb.insert(chatTurns).values({
    cancellationReason: "user-stop",
    createdAt,
    id: createSafeId<"chatTurn">(),
    organizationId: ids.orgA,
    settledAt: new Date(createdAt.getTime() + 60_000),
    status: "cancelled",
    threadId,
    updatedAt: createdAt,
    userId: ids.userA1,
    userMessageId,
    workspaceId: null,
  });
};

const listThreads = async ({
  caller = callerOf(),
  pinState,
}: {
  caller?: Caller;
  pinState?: ChatThreadPinState | undefined;
} = {}) => {
  const listed = await getThreads.handler(
    asTestRaw<ListCtx>({
      ...contextOf(caller),
      query: {
        limit: 100,
        ...(pinState === undefined ? {} : { pinState }),
      },
      request: new Request("http://localhost/v1/chat/threads"),
      route: "/v1/chat/threads" satisfies ApiRoutePath,
    }),
  );
  if (!("global" in listed)) {
    return panic(`Thread list failed: ${JSON.stringify(listed)}`);
  }
  return [
    ...listed.global,
    ...listed.workspaces.flatMap((group) => group.threads),
  ];
};

const listedThread = async (threadId: string) =>
  (await listThreads()).find((thread) => thread.id === threadId) ??
  panic(`Thread ${threadId} is not listed`);

const markRead = async ({
  caller = callerOf(),
  readState,
  threadId,
  workspaceId,
}: {
  caller?: Caller;
  readState: ChatThreadReadState;
  threadId: SafeId<"chatThread">;
  workspaceId?: SafeId<"workspace"> | undefined;
}) =>
  await updateChatThreadReadState.handler(
    asTestRaw<ReadCtx>({
      ...contextOf(caller),
      body: { readState },
      params: { threadId },
      query: workspaceId === undefined ? {} : { workspaceId },
      request: new Request(
        `http://localhost/v1/chat/threads/${threadId}/read-state`,
      ),
      route: "/v1/chat/threads/:threadId/read-state" satisfies ApiRoutePath,
    }),
  );

const pin = async ({
  caller = callerOf(),
  onAudit = () => undefined,
  pinState,
  threadId,
  workspaceId,
}: {
  caller?: Caller;
  onAudit?: (events: readonly AuditEvent[]) => void;
  pinState: ChatThreadPinState;
  threadId: SafeId<"chatThread">;
  workspaceId?: SafeId<"workspace"> | undefined;
}) =>
  await updateChatThreadPinState.handler(
    asTestRaw<PinCtx>({
      ...contextOf(caller),
      body: { pinState },
      params: { threadId },
      query: workspaceId === undefined ? {} : { workspaceId },
      recordAuditEvent: auditRecorderDouble(onAudit),
      request: new Request(
        `http://localhost/v1/chat/threads/${threadId}/pin-state`,
      ),
      route: "/v1/chat/threads/:threadId/pin-state" satisfies ApiRoutePath,
    }),
  );

describe("a chat's read state", () => {
  test("an answer that settled after the last read reads unread until marked read", async () => {
    const threadId = await seedAnsweredThread({ title: "Answered" });
    // Last open before the answer settled.
    await setLastReadAt(threadId, at(0));
    expect((await listedThread(threadId)).readState).toBe(
      CHAT_THREAD_READ_STATE.unread,
    );

    expect(
      await markRead({ readState: CHAT_THREAD_READ_STATE.read, threadId }),
    ).toEqual({ readState: CHAT_THREAD_READ_STATE.read });
    expect((await listedThread(threadId)).readState).toBe(
      CHAT_THREAD_READ_STATE.read,
    );
    // Idempotent: marking a read chat read again keeps it read.
    await markRead({ readState: CHAT_THREAD_READ_STATE.read, threadId });
    expect((await listedThread(threadId)).readState).toBe(
      CHAT_THREAD_READ_STATE.read,
    );
  });

  test("an answer the reader already had open reads read", async () => {
    const threadId = await seedAnsweredThread({ title: "Seen" });
    await setLastReadAt(threadId, at(SETTLE_DELAY_S));
    expect((await listedThread(threadId)).readState).toBe(
      CHAT_THREAD_READ_STATE.read,
    );
  });

  test("marking unread holds even with no newer answer", async () => {
    const threadId = await seedAnsweredThread({ title: "Flagged" });
    // Seeded threads start read: their answers predate the insert.
    expect((await listedThread(threadId)).readState).toBe(
      CHAT_THREAD_READ_STATE.read,
    );
    await markRead({ readState: CHAT_THREAD_READ_STATE.unread, threadId });
    expect((await listedThread(threadId)).readState).toBe(
      CHAT_THREAD_READ_STATE.unread,
    );
  });

  test("a later turn stopped before answering leaves the earlier answer deciding", async () => {
    const threadId = await seedAnsweredThread({ title: "Stopped later" });
    await setLastReadAt(threadId, at(SETTLE_DELAY_S));
    // Settles well after the last read, but carries no answer to read.
    await appendCancelledTurn(threadId, at(30));
    expect((await listedThread(threadId)).readState).toBe(
      CHAT_THREAD_READ_STATE.read,
    );
  });

  test("reading a chat does not move it in the history", async () => {
    const older = await seedAnsweredThread({ title: "Older" });
    const newer = await seedAnsweredThread({
      createdAtSeconds: 10,
      title: "Newer",
    });
    const before = await listedThread(older);
    await markRead({ readState: CHAT_THREAD_READ_STATE.read, threadId: older });
    await markRead({
      readState: CHAT_THREAD_READ_STATE.unread,
      threadId: older,
    });
    const after = await listedThread(older);
    expect(after.updatedAt).toEqual(before.updatedAt);
    const order = (await listThreads())
      .map((thread) => thread.id)
      .filter((id) => id === older || id === newer);
    expect(order).toEqual([newer, older]);
  });
});

describe("a chat's pin state", () => {
  test("pinned and unpinned lists split the reader's chats", async () => {
    const pinned = await seedAnsweredThread({ title: "Pinned" });
    const unpinned = await seedAnsweredThread({
      createdAtSeconds: 10,
      title: "Unpinned",
    });
    expect((await listedThread(pinned)).pinState).toBe(
      CHAT_THREAD_PIN_STATE.unpinned,
    );

    const audited: AuditEvent[] = [];
    expect(
      await pin({
        onAudit: (events) => {
          audited.push(...events);
        },
        pinState: CHAT_THREAD_PIN_STATE.pinned,
        threadId: pinned,
      }),
    ).toEqual({ pinState: CHAT_THREAD_PIN_STATE.pinned });
    expect(audited.map((event) => event.changes)).toEqual([
      {
        pinState: {
          old: CHAT_THREAD_PIN_STATE.unpinned,
          new: CHAT_THREAD_PIN_STATE.pinned,
        },
      },
    ]);

    const seeded = new Set<string>([pinned, unpinned]);
    const idsIn = async (pinState: ChatThreadPinState) =>
      (await listThreads({ pinState }))
        .map((thread) => thread.id)
        .filter((id) => seeded.has(id));
    expect(await idsIn(CHAT_THREAD_PIN_STATE.pinned)).toEqual([pinned]);
    expect(await idsIn(CHAT_THREAD_PIN_STATE.unpinned)).toEqual([unpinned]);
    expect((await listedThread(pinned)).pinState).toBe(
      CHAT_THREAD_PIN_STATE.pinned,
    );

    // Pinning again records nothing; unpinning returns it to the rest.
    await pin({
      onAudit: (events) => {
        audited.push(...events);
      },
      pinState: CHAT_THREAD_PIN_STATE.pinned,
      threadId: pinned,
    });
    expect(audited).toHaveLength(1);
    await pin({ pinState: CHAT_THREAD_PIN_STATE.unpinned, threadId: pinned });
    expect(await idsIn(CHAT_THREAD_PIN_STATE.pinned)).toEqual([]);
  });
});

const storedPinnedAt = async (threadId: SafeId<"chatThread">) => {
  const [row] = await testDb
    .select({ pinnedAt: chatThreads.pinnedAt })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId));
  return row === undefined ? panic("the thread is stored") : row.pinnedAt;
};

/** The one broadcast a state change sends: to the reader's own devices. */
const readerPing = (): Ping => ({
  event: chatThreadsChangedRealtimeEvent(),
  organizationId: ids.orgA,
  userId: ids.userA1,
});

type ReaderRequest =
  | { kind: "read"; readState: ChatThreadReadState }
  | { kind: "pin"; pinState: ChatThreadPinState };

const READER_REQUESTS: readonly ReaderRequest[] = [
  { kind: "read", readState: CHAT_THREAD_READ_STATE.read },
  { kind: "read", readState: CHAT_THREAD_READ_STATE.unread },
  { kind: "pin", pinState: CHAT_THREAD_PIN_STATE.pinned },
  { kind: "pin", pinState: CHAT_THREAD_PIN_STATE.unpinned },
];

const send = async (
  threadId: SafeId<"chatThread">,
  request: ReaderRequest,
): Promise<unknown> =>
  request.kind === "read"
    ? await markRead({ readState: request.readState, threadId })
    : await pin({ pinState: request.pinState, threadId });

const bodyOf = (request: ReaderRequest) =>
  request.kind === "read"
    ? { readState: request.readState }
    : { pinState: request.pinState };

describe("a request for the state a chat already has", () => {
  test("succeeds with the same answer, writes nothing and tells no device", async () => {
    const threadId = await seedAnsweredThread({ title: "Settled" });
    // Seeded threads start read and unpinned; each request first changes
    // the state, then asks for it again.
    for (const request of [
      { kind: "read", readState: CHAT_THREAD_READ_STATE.unread },
      { kind: "read", readState: CHAT_THREAD_READ_STATE.read },
      { kind: "pin", pinState: CHAT_THREAD_PIN_STATE.pinned },
      { kind: "pin", pinState: CHAT_THREAD_PIN_STATE.unpinned },
    ] satisfies ReaderRequest[]) {
      // db-await-in-loop: four requests, each a state change then a repeat
      expect(await send(threadId, request)).toEqual(bodyOf(request));
      expect(takePings()).toEqual([readerPing()]);
      // db-await-in-loop: the repeat of the request just sent
      expect(await send(threadId, request)).toEqual(bodyOf(request));
      expect(takePings()).toEqual([]);
    }
  });

  test("re-pinning keeps the chat's place among the pinned ones", async () => {
    const threadId = await seedAnsweredThread({ title: "Pinned first" });
    await pin({ pinState: CHAT_THREAD_PIN_STATE.pinned, threadId });
    const pinnedAt = await storedPinnedAt(threadId);
    expect(pinnedAt).not.toBeNull();
    await pin({ pinState: CHAT_THREAD_PIN_STATE.pinned, threadId });
    expect(await storedPinnedAt(threadId)).toEqual(pinnedAt);
  });

  test("marking unread a chat a newer answer already made unread changes nothing", async () => {
    const threadId = await seedAnsweredThread({ title: "Newer answer" });
    // Last open before the answer settled: unread with a stored marker.
    await setLastReadAt(threadId, at(0));
    expect(
      await markRead({ readState: CHAT_THREAD_READ_STATE.unread, threadId }),
    ).toEqual({ readState: CHAT_THREAD_READ_STATE.unread });
    expect(takePings()).toEqual([]);
    expect((await listedThread(threadId)).readState).toBe(
      CHAT_THREAD_READ_STATE.unread,
    );
  });

  test("tells the reader's devices once per state change over any sequence of requests", async () => {
    const threadId = await seedAnsweredThread({ title: "Sequenced" });
    await assertProperty(
      "tells the reader's devices once per state change over any sequence of requests",
      fc.asyncProperty(
        fc.array(fc.constantFrom(...READER_REQUESTS), {
          maxLength: 8,
          minLength: 1,
        }),
        async (requests) => {
          // Every run starts from a read, unpinned chat.
          await setLastReadAt(threadId, at(SETTLE_DELAY_S));
          await testDb
            .update(chatThreads)
            .set({ pinnedAt: null, updatedAt: sql`${chatThreads.updatedAt}` })
            .where(eq(chatThreads.id, threadId));
          takePings();
          let readState: ChatThreadReadState = CHAT_THREAD_READ_STATE.read;
          let pinState: ChatThreadPinState = CHAT_THREAD_PIN_STATE.unpinned;
          let changes = 0;
          for (const request of requests) {
            // db-await-in-loop: the sequence is the property's input, in order
            expect(await send(threadId, request)).toEqual(bodyOf(request));
            if (request.kind === "read" && request.readState !== readState) {
              readState = request.readState;
              changes += 1;
            }
            if (request.kind === "pin" && request.pinState !== pinState) {
              pinState = request.pinState;
              changes += 1;
            }
          }
          expect(takePings()).toEqual(
            Array.from({ length: changes }, readerPing),
          );
          const listed = await listedThread(threadId);
          expect({
            pinState: listed.pinState,
            readState: listed.readState,
          }).toEqual({ pinState, readState });
        },
      ),
      propertyConfig({ numRuns: 20 }),
    );
  });
});

describe("only the chat's own reader, in its own scope, changes its states", () => {
  test("a colleague, a wrong scope or an unreachable matter is not found and changes nothing", async () => {
    const globalThread = await seedAnsweredThread({ title: "Global" });
    const matterThread = await seedAnsweredThread({
      title: "Matter",
      workspaceId: ids.wsA1,
    });
    const colleague = callerOf({ userId: ids.userA2 });
    const outsider = callerOf({ workspaceIds: [ids.wsA2] });

    const attempts = [
      // A colleague in the same organization and matter.
      { caller: colleague, threadId: globalThread, workspaceId: undefined },
      { caller: colleague, threadId: matterThread, workspaceId: ids.wsA1 },
      // The reader naming the wrong scope for the thread.
      { caller: callerOf(), threadId: matterThread, workspaceId: undefined },
      { caller: callerOf(), threadId: globalThread, workspaceId: ids.wsA1 },
      // The reader without access to the thread's matter.
      { caller: outsider, threadId: matterThread, workspaceId: ids.wsA1 },
    ];
    for (const attempt of attempts) {
      // db-await-in-loop: five refused writes, each checked on its own
      expect(
        await markRead({
          ...attempt,
          readState: CHAT_THREAD_READ_STATE.unread,
        }),
      ).toMatchObject({ code: 404 });
      // db-await-in-loop: five refused writes, each checked on its own
      expect(
        await pin({ ...attempt, pinState: CHAT_THREAD_PIN_STATE.pinned }),
      ).toMatchObject({ code: 404 });
    }

    const rows = await testDb
      .select({
        lastReadAt: chatThreads.lastReadAt,
        pinnedAt: chatThreads.pinnedAt,
      })
      .from(chatThreads)
      .where(inArray(chatThreads.id, [globalThread, matterThread]));
    for (const row of rows) {
      expect(row.lastReadAt).not.toBeNull();
      expect(row.pinnedAt).toBeNull();
    }
    expect(takePings()).toEqual([]);

    // The reader in the right scope succeeds.
    expect(
      await pin({
        pinState: CHAT_THREAD_PIN_STATE.pinned,
        threadId: matterThread,
        workspaceId: ids.wsA1,
      }),
    ).toEqual({ pinState: CHAT_THREAD_PIN_STATE.pinned });
  });
});

describe("the pinned chats read", () => {
  test("reads the same work for ten pinned chats whatever the rest of the history holds", async () => {
    const seedAt = async (size: number) =>
      await seedChatThreadsScaling(testDb, {
        // The scaling page is this organization's only content.
        organizationId: ids.orgB,
        userId: ids.userA1,
        workspaceId: ids.wsB1,
        size,
      });
    const small = await seedAt(10);
    try {
      const at10 = await chatPinnedThreadsScalingScenario.measure(small);
      await small.cleanup();
      const large = await seedAt(200);
      try {
        const at200 = await chatPinnedThreadsScalingScenario.measure(large);
        console.info(
          "handler-scaling",
          JSON.stringify({ name: "chat pinned threads", at10, at200 }),
        );
        expect(at10.rows).toBe(PINNED_THREADS_PAGE);
        expect(at200.rows).toBe(PINNED_THREADS_PAGE);
        expect(at10.statements).toBeGreaterThan(0);
        expect(readScalingViolations({ small: at10, large: at200 })).toEqual(
          [],
        );
      } finally {
        await large.cleanup();
      }
    } finally {
      await small.cleanup();
    }
  });
});
