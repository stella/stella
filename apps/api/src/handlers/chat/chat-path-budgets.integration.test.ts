import { EventType } from "@tanstack/ai";
import { panic } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Logger } from "drizzle-orm";
import { AsyncLocalStorage } from "node:async_hooks";

import { CHAT_TURN_ID_HEADER } from "@stll/api-contract";
import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";
import { waitForExternalState } from "@stll/property-testing/external-state";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  chatMessages,
  chatRunLogEntries,
  chatRunLogs,
  chatThreads,
  chatTurns,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import getMessages from "@/api/handlers/chat/messages/list";
import getOlderMessages from "@/api/handlers/chat/older-messages/list";
import { joinChatTurn, probeChatTurn } from "@/api/handlers/chat/turns/resume";
import type { ChatPart } from "@/api/handlers/chat/types";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { MAX_CATCHUP_BYTES, MAX_CATCHUP_CHUNKS } from "@/api/lib/chat/run-log";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  createApprovalHarness,
  PLAIN_TOOL_NAME,
} from "@/api/tests/helpers/chat-approval-harness";
import type { ChatHarness } from "@/api/tests/helpers/chat-approval-harness";
import type { ScriptedTurn } from "@/api/tests/helpers/chat-round-trip";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { withQueryLogger } from "@/api/tests/security/test-utils";

// What each chat path costs the database and the wire, measured through the
// real handlers: the send route and `streamChat` with a scripted model behind
// the adapter seam (`chat-approval-harness.ts`), the thread page, the older
// page, the rejoin probe and join, and Stop, all against the test database.
// Every path runs on a short thread and on a long one and must cost the same
// SQL on both: a per-message or per-tool-call query (an N+1) fails here
// however small its absolute cost. Bytes are bounded per page and per streamed
// delta, never per thread.
//
// Calibration: `measured` is what main measured, identical on the short and
// the long thread. A budget is that measurement plus a small headroom
// (`withHeadroom`): 10% of the statements, at least one, and 15% of the
// bytes; a measurement that also depends on timing gets its stated
// `TIMING_ALLOWANCE` instead. Byte figures hold for this fixture's messages (a text question, an
// answer with its tool calls); they bound the envelope, not message content.
// A failure prints the whole measurement.

setDefaultTimeout(240_000);

/** The threads every path runs on: what a long thread may not pay for. */
const THREADS = {
  short: { messages: 10, toolCalls: 0 },
  long: { messages: 500, toolCalls: 200 },
} as const;

/** What one streamed text delta carries. */
const DELTA_TEXT = "word ";
/** Text deltas of the two answers whose difference prices one delta. */
const STREAMED_DELTAS = { few: 100, many: 400 } as const;
/** Deltas a rejoined run holds: one replay within the catch-up bound, one
 *  past it (`MAX_CATCHUP_CHUNKS`), which the join folds into a snapshot. */
const REJOINED_DELTAS = { replayed: 100, snapshotted: 600 } as const;

const CHAT_PATH_BUDGETS = {
  /** The thread page: thread, settings, the newest page, context estimate. */
  openThread: { measured: { pageBytes: 15_245, statements: 9 } },
  /** One older page. */
  olderPage: { measured: { pageBytes: 14_365, statements: 5 } },
  /** A send up to its first delivery-log append: the thread and history
   *  reads, the turn's acceptance and claim, the run's setup. */
  sendUntilStream: { measured: { statements: 58 } },
  /** The streamed answer: delivery-log appends batch deltas, so a delta
   *  costs a share of one append, and its SSE event a fixed frame. */
  streamedText: {
    measured: {
      framingBytesPerDelta: 135,
      statementsPer100Deltas: 21,
      statementsPerAppend: 7,
    },
  },
  /** The turn's settlement after its last append: the assistant message,
   *  the turn row, the closed log. */
  settleTurn: { measured: { statements: 10 } },
  /** The rejoin probe of a running turn. */
  rejoinProbe: { measured: { bytes: 117, statements: 2 } },
  /** Joining a running turn from its start, up to its current tail. */
  rejoinJoin: {
    measured: {
      replayedBytes: 15_166,
      replayedStatements: 8,
      snapshotBytes: 3672,
      snapshotStatements: 13,
    },
  },
  /** The Stop route on a running turn. */
  stop: { measured: { statements: 6 } },
} as const satisfies Record<
  string,
  { measured: Readonly<Record<string, number>> }
>;

/**
 * Measurements that depend on timing as well as on the code. The delivery
 * producer flushes a batch early once the next delta waits past its batch
 * window, so a loaded machine appends partial batches: the per-delta share
 * of an append may double. A producer appending per delta costs 700 per 100
 * deltas, still an order of magnitude over.
 */
const TIMING_ALLOWANCE: Readonly<Record<string, number>> = {
  statementsPer100Deltas: 2,
};

const withHeadroom = (name: string, value: number): number => {
  const allowance = TIMING_ALLOWANCE[name];
  if (allowance !== undefined) {
    return Math.ceil(value * allowance);
  }
  if (/bytes/iu.test(name)) {
    return Math.ceil(value * 1.15);
  }
  if (/statements/iu.test(name)) {
    return value + Math.max(1, Math.ceil(value * 0.1));
  }
  return panic(`No headroom rule for ${name}`);
};

/** A path's budget getter: each measurement plus its headroom. */
const budgetOf = <TPath extends keyof typeof CHAT_PATH_BUDGETS>(
  path: TPath,
) => {
  const measured: Readonly<Record<string, number>> =
    CHAT_PATH_BUDGETS[path].measured;
  return (
    name: Extract<keyof (typeof CHAT_PATH_BUDGETS)[TPath]["measured"], string>,
  ) => {
    const value = measured[name];
    if (value === undefined) {
      return panic(`No ${name} measurement for ${path}`);
    }
    return withHeadroom(name, value);
  };
};

type StatementLog = { statements: string[] };
const statementStore = new AsyncLocalStorage<StatementLog>();
const recordingLogger: Logger = {
  logQuery: (query) => {
    statementStore.getStore()?.statements.push(query);
  },
};

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = withQueryLogger(fixture.testDb, recordingLogger);
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).byteLength;
const jsonBytes = async (value: unknown) =>
  (await Response.json(value).arrayBuffer()).byteLength;

const seedThread = async ({
  messages,
  toolCalls,
}: {
  messages: number;
  toolCalls: number;
}) => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Budget thread",
    userId: ids.userA1,
    workspaceId: null,
  });
  const pairs = messages / 2;
  const start = Date.now() - 86_400_000;
  const messageRows = [];
  const turnRows = [];
  for (let pair = 0; pair < pairs; pair += 1) {
    const userMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const assistantMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const callsHere =
      Math.floor(((pair + 1) * toolCalls) / pairs) -
      Math.floor((pair * toolCalls) / pairs);
    const calls: ChatPart[] = Array.from({ length: callsHere }, (_, index) => ({
      arguments: "{}",
      id: `call-seed-${String(pair)}-${String(index)}`,
      input: {},
      metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
      name: PLAIN_TOOL_NAME,
      output: { templates: [] },
      state: "complete",
      type: "tool-call",
    }));
    const createdAt = new Date(start + pair * 2000);
    messageRows.push(
      {
        content: toPersistedChatMessageContentV3({
          data: [{ content: `Question ${String(pair)}`, type: "text" }],
        }),
        createdAt,
        id: userMessageId,
        role: "user" as const,
        threadId,
        userId: ids.userA1,
        workspaceId: null,
      },
      {
        content: toPersistedChatMessageContentV3({
          data: [...calls, { content: `Answer ${String(pair)}`, type: "text" }],
        }),
        createdAt: new Date(createdAt.getTime() + 1000),
        id: assistantMessageId,
        role: "assistant" as const,
        threadId,
        userId: ids.userA1,
        workspaceId: null,
      },
    );
    turnRows.push({
      activeDurationMs: 900,
      assistantMessageId,
      createdAt,
      id: toSafeId<"chatTurn">(Bun.randomUUIDv7()),
      organizationId: ids.orgA,
      runId: `run-seed-${Bun.randomUUIDv7()}`,
      settledAt: new Date(createdAt.getTime() + 1000),
      status: "completed" as const,
      threadId,
      timingMessageId: assistantMessageId,
      userId: ids.userA1,
      userMessageId,
      workspaceId: null,
    });
  }
  for (let index = 0; index < messageRows.length; index += 200) {
    await testDb
      .insert(chatMessages)
      .values(messageRows.slice(index, index + 200));
  }
  for (let index = 0; index < turnRows.length; index += 200) {
    await testDb.insert(chatTurns).values(turnRows.slice(index, index + 200));
  }
  return threadId;
};

/** Runs `operation` with every statement it (and whatever it starts)
 *  issues recorded in its own log. */
const recorded = async <T>(operation: () => Promise<T>) => {
  const log: StatementLog = { statements: [] };
  const value = await statementStore.run(log, operation);
  return { log, value };
};

const isScopeStart = (statement: string) =>
  /^\s*select\s+set_config\('role'/iu.test(statement);
const isRunLogAppend = (statement: string) =>
  statement.startsWith('insert into "chat_run_log_entries"');

/** A send's statements as transactions, each opened by its scope. */
const transactionsOf = (statements: readonly string[]) => {
  const transactions: string[][] = [];
  for (const statement of statements) {
    const current = transactions.at(-1);
    if (current === undefined || isScopeStart(statement)) {
      transactions.push([statement]);
    } else {
      current.push(statement);
    }
  }
  return transactions;
};

/**
 * A send's statements in three phases: up to its first delivery-log append
 * (the request, its thread reads and the turn's acceptance), from the first
 * append to the last (the streamed response), and after it (the turn's
 * settlement).
 */
const sendPhasesOf = (statements: readonly string[]) => {
  const transactions = transactionsOf(statements);
  const appends = transactions.flatMap((transaction, index) =>
    transaction.some(isRunLogAppend) ? [index] : [],
  );
  const first = appends.at(0) ?? panic("The send appended nothing");
  const last = appends.at(-1) ?? first;
  const count = (from: number, to: number) =>
    transactions.slice(from, to).reduce((sum, { length }) => sum + length, 0);
  return {
    appendStatements: appends.map((index) => transactions[index]?.length ?? 0),
    appends: appends.length,
    beforeStream: count(0, first),
    settlement: count(last + 1, transactions.length),
    streaming: count(first, last + 1),
  };
};

const userMessage = (text: string) => ({
  id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
  parts: [{ content: text, type: "text" as const }],
  role: "user" as const,
});

const textAnswer = (deltas: number): ScriptedTurn => ({
  finishReason: "stop",
  text: "answer",
  textChunks: Array.from({ length: deltas }, () => DELTA_TEXT),
  toolCalls: [],
  type: "step",
});

/** Sends one message answered with `deltas` text deltas, recorded. */
const measureSend = async ({
  deltas,
  harness,
  threadId,
}: {
  deltas: number;
  harness: ChatHarness;
  threadId: SafeId<"chatThread">;
}) => {
  harness.script(threadId, [textAnswer(deltas)]);
  const { log, value } = await recorded(
    async () =>
      await harness.sendUnchecked(
        harness.sendContext({
          message: userMessage("One more question"),
          runId: `run-${Bun.randomUUIDv7()}`,
          threadId,
        }),
      ),
  );
  if (!(value instanceof Response && value.ok)) {
    return panic("The send was refused", value);
  }
  const body = await value.text();
  expect(await harness.awaitSettledTurns(threadId)).toEqual([]);
  await harness.awaitRunsSettled(threadId);
  return { bytes: byteLength(body), ...sendPhasesOf(log.statements) };
};

const readerContext = (threadId: SafeId<"chatThread">) => ({
  getWorkspaceAccess: async () => await Promise.resolve(null),
  managedAIResidency: "eu",
  memberRole: sessionMemberRole("owner"),
  orgAIConfig: null,
  orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
  promptCachingEnabled: false,
  request: new Request(`http://localhost/v1/chat/threads/${threadId}`),
  safeDb,
  scopedDb,
  session: { activeOrganizationId: ids.orgA },
  set: { headers: {}, status: 200 },
  user: { id: ids.userA1 },
});

const loadThreadPage = async (threadId: SafeId<"chatThread">) => {
  const { log, value } = await recorded(
    async () =>
      await getMessages.handler(
        asTestRaw<Parameters<typeof getMessages.handler>[0]>({
          ...readerContext(threadId),
          route: "/v1/chat/threads/:threadId/messages" satisfies ApiRoutePath,
          params: { threadId },
          query: {},
        }),
      ),
  );
  const page = asTestRaw<{ messages: unknown[]; olderCursor: string | null }>(
    value,
  );
  return {
    bytes: await jsonBytes(value),
    messages: page.messages.length,
    olderCursor: page.olderCursor,
    statements: log.statements.length,
  };
};

const loadOlderPage = async (
  threadId: SafeId<"chatThread">,
  before: string,
) => {
  const { log, value } = await recorded(
    async () =>
      await getOlderMessages.handler(
        asTestRaw<Parameters<typeof getOlderMessages.handler>[0]>({
          ...readerContext(threadId),
          route:
            "/v1/chat/threads/:threadId/messages/older" satisfies ApiRoutePath,
          params: { threadId },
          query: { before },
        }),
      ),
  );
  const page = asTestRaw<{ messages: unknown[]; olderCursor: string | null }>(
    value,
  );
  return {
    bytes: await jsonBytes(value),
    messages: page.messages.length,
    olderCursor: page.olderCursor,
    statements: log.statements.length,
  };
};

/** The SSE events of `response` up to the one whose id is `lastId`. */
const readSseUntil = async (response: Response, lastId: bigint) => {
  const body = response.body ?? panic("The join returned no body");
  const decoder = new TextDecoder();
  let buffered = "";
  let bytes = 0;
  const eventIds: (bigint | undefined)[] = [];
  const reader = body.getReader();
  try {
    while (!((eventIds.at(-1) ?? -1n) >= lastId)) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      buffered += decoder.decode(value, { stream: true });
      const blocks = buffered.split("\n\n");
      buffered = blocks.pop() ?? "";
      for (const lines of blocks.map((block) => block.split("\n"))) {
        if (lines.some((line) => line.startsWith("data: "))) {
          const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
          eventIds.push(id === undefined ? undefined : BigInt(id));
        }
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return { bytes, events: eventIds.length };
};

/**
 * A turn streaming `deltas` text deltas that then pauses before its tool
 * call ends: what a viewer rejoins and what a user stops.
 */
const startPausedTurn = async ({
  deltas,
  harness,
  threadId,
}: {
  deltas: number;
  harness: ChatHarness;
  threadId: SafeId<"chatThread">;
}) => {
  const paused = Promise.withResolvers<undefined>();
  const runId = `run-${Bun.randomUUIDv7()}`;
  harness.script(threadId, [
    {
      pause: { at: "before-tool-end", wait: async () => await paused.promise },
      text: "answer",
      textChunks: Array.from({ length: deltas }, () => DELTA_TEXT),
      toolCalls: [
        {
          arguments: "{}",
          toolCallId: `call-${runId}`,
          toolName: PLAIN_TOOL_NAME,
        },
      ],
      type: "step",
    },
    { finishReason: "stop", text: "Done.", type: "text" },
  ]);
  const response = await harness.sendUnchecked(
    harness.sendContext({
      message: userMessage("Draft it"),
      runId,
      threadId,
    }),
  );
  if (!(response instanceof Response && response.ok)) {
    return panic("The send was refused", response);
  }
  const turnId = toSafeId<"chatTurn">(
    response.headers.get(CHAT_TURN_ID_HEADER) ?? panic("No turn header"),
  );
  const drained = response.text();
  // The tool call's arguments are the last thing the run stores before it
  // pauses.
  await waitForExternalState({
    description: "the run stores the tool call's arguments",
    intervalMs: 20,
    timeoutMs: 10_000,
    read: async () =>
      (
        await testDb
          .select({ seq: chatRunLogEntries.seq })
          .from(chatRunLogEntries)
          .where(
            and(
              eq(chatRunLogEntries.runId, runId),
              sql`${chatRunLogEntries.chunk}->>'type' = ${EventType.TOOL_CALL_ARGS}`,
            ),
          )
          .limit(1)
      ).at(0),
  });
  const [log] = await testDb
    .select({ nextSeq: chatRunLogs.nextSeq })
    .from(chatRunLogs)
    .where(eq(chatRunLogs.runId, runId))
    .limit(1);
  return {
    finish: async () => {
      paused.resolve(undefined);
      await drained;
      expect(await harness.awaitSettledTurns(threadId)).toEqual([]);
    },
    runId,
    tail: (log?.nextSeq ?? panic("No delivery log")) - 1n,
    turnId,
  };
};

const turnContext = (
  threadId: SafeId<"chatThread">,
  turnId: SafeId<"chatTurn">,
  query: Record<string, string>,
) =>
  asTestRaw<Parameters<typeof probeChatTurn.handler>[0]>({
    ...readerContext(threadId),
    params: { threadId, turnId },
    query,
    route:
      "/v1/chat/threads/:threadId/turns/:turnId/join" satisfies ApiRoutePath,
  });

const measureRejoin = async ({
  deltas,
  harness,
  threadId,
}: {
  deltas: number;
  harness: ChatHarness;
  threadId: SafeId<"chatThread">;
}) => {
  const turn = await startPausedTurn({ deltas, harness, threadId });
  const probe = await recorded(
    async () =>
      await probeChatTurn.handler(
        turnContext(threadId, turn.turnId, { runId: turn.runId }),
      ),
  );
  expect(probe.value).toMatchObject({ type: "running" });
  const join = await recorded(async () => {
    const response = await joinChatTurn.handler(
      turnContext(threadId, turn.turnId, {
        lastEventId: "-1",
        runId: turn.runId,
      }),
    );
    if (!(response instanceof Response)) {
      return panic("The join did not stream", response);
    }
    return await readSseUntil(response, turn.tail);
  });
  const stop = await recorded(
    async () => await harness.stopTurn({ threadId, turnId: turn.turnId }),
  );
  expect(stop.value.status).toBe(200);
  await turn.finish();
  return {
    catchUpBytes: join.value.bytes,
    catchUpEvents: join.value.events,
    joinStatements: join.log.statements.length,
    logEntries: Number(turn.tail),
    probeBytes: await jsonBytes(probe.value),
    probeStatements: probe.log.statements.length,
    stopStatements: stop.log.statements.length,
  };
};

type ThreadMeasurement = Awaited<ReturnType<typeof measureThread>>;

/** Every path on one thread of `size`, in the order a user meets them. */
const measureThread = async (
  harness: ChatHarness,
  size: (typeof THREADS)[keyof typeof THREADS],
) => {
  const threadId = await seedThread(size);
  // The first send on a seeded thread starts its name ledger, as every
  // thread's first send does; the measured sends are later ones.
  await measureSend({ deltas: 1, harness, threadId });
  const open = await loadThreadPage(threadId);
  const olderPages = [];
  let cursor = open.olderCursor;
  while (cursor !== null) {
    // Walks the thread back page by page, as a reader scrolling up does.
    const page = await loadOlderPage(threadId, cursor);
    olderPages.push({
      bytes: page.bytes,
      messages: page.messages,
      statements: page.statements,
    });
    cursor = page.olderCursor;
  }
  const few = await measureSend({
    deltas: STREAMED_DELTAS.few,
    harness,
    threadId,
  });
  const many = await measureSend({
    deltas: STREAMED_DELTAS.many,
    harness,
    threadId,
  });
  const replayed = await measureRejoin({
    deltas: REJOINED_DELTAS.replayed,
    harness,
    threadId,
  });
  const snapshotted = await measureRejoin({
    deltas: REJOINED_DELTAS.snapshotted,
    harness,
    threadId,
  });
  const extraDeltas = STREAMED_DELTAS.many - STREAMED_DELTAS.few;
  return {
    olderPages,
    openThread: {
      messages: open.messages,
      pageBytes: open.bytes,
      statements: open.statements,
    },
    rejoin: { replayed, snapshotted },
    send: {
      appendStatements: [...few.appendStatements, ...many.appendStatements],
      beforeStream: [few.beforeStream, many.beforeStream],
      // What one more delta adds: its SSE frame beyond the five characters
      // it carries, and its share of a batched append.
      framingBytesPerDelta:
        (many.bytes - few.bytes) / extraDeltas - DELTA_TEXT.length,
      settlement: [few.settlement, many.settlement],
      statementsPer100Deltas:
        ((many.streaming - few.streaming) / extraDeltas) * 100,
      streaming: [few.streaming, many.streaming],
    },
  };
};

let measured: { long: ThreadMeasurement; short: ThreadMeasurement };
let report = "";

/** Both threads cost `pick` the same statements, each within `budget`. */
const expectFlatStatements = (
  pick: (thread: ThreadMeasurement) => number | readonly number[],
  budget: number,
) => {
  const short = [pick(measured.short)].flat();
  const long = [pick(measured.long)].flat();
  expect(long, report).toEqual(short);
  for (const statements of short) {
    expect(statements, report).toBeLessThanOrEqual(budget);
  }
};

describe("chat path budgets", () => {
  beforeAll(async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    try {
      measured = {
        long: await measureThread(harness, THREADS.long),
        short: await measureThread(harness, THREADS.short),
      };
    } finally {
      await harness.close();
    }
    report = `measured ${JSON.stringify(measured)}`;
  });

  test("the long thread is long enough to expose a per-message cost", () => {
    const served = [
      measured.long.openThread.messages,
      ...measured.long.olderPages.map(({ messages }) => messages),
    ].reduce((sum, messages) => sum + messages, 0);
    expect(served, report).toBeGreaterThanOrEqual(THREADS.long.messages);
    expect(measured.long.olderPages.length, report).toBeGreaterThan(2);
  });

  test("opening a thread reads one page, whatever the thread holds", () => {
    const budget = budgetOf("openThread");
    expectFlatStatements(
      ({ openThread }) => openThread.statements,
      budget("statements"),
    );
    for (const { openThread } of [measured.short, measured.long]) {
      expect(openThread.pageBytes, report).toBeLessThanOrEqual(
        budget("pageBytes"),
      );
    }
  });

  test("an older page costs the same at any depth", () => {
    const budget = budgetOf("olderPage");
    const first =
      measured.long.olderPages.at(0) ??
      panic("The long thread has no older page");
    for (const page of measured.long.olderPages) {
      expect(page.statements, report).toBe(first.statements);
      expect(page.statements, report).toBeLessThanOrEqual(budget("statements"));
      expect(page.bytes, report).toBeLessThanOrEqual(budget("pageBytes"));
    }
  });

  test("a send reaches its stream in a fixed number of statements", () => {
    expectFlatStatements(
      ({ send }) => send.beforeStream,
      budgetOf("sendUntilStream")("statements"),
    );
  });

  test("a streamed delta costs a share of a batched append and a fixed frame", () => {
    const budget = budgetOf("streamedText");
    // How many appends a stream takes depends on when batches flush, so the
    // thread-length check holds each append's plan, not their number.
    expectFlatStatements(
      ({ send }) =>
        // Unique after the Set, so no two entries compare equal.
        [...new Set(send.appendStatements)].toSorted((a, b) =>
          a < b ? -1 : 1,
        ),
      budget("statementsPerAppend"),
    );
    for (const { send } of [measured.short, measured.long]) {
      expect(send.statementsPer100Deltas, report).toBeLessThanOrEqual(
        budget("statementsPer100Deltas"),
      );
      expect(send.framingBytesPerDelta, report).toBeLessThanOrEqual(
        budget("framingBytesPerDelta"),
      );
    }
  });

  test("a turn settles in a fixed number of statements", () => {
    expectFlatStatements(
      ({ send }) => send.settlement,
      budgetOf("settleTurn")("statements"),
    );
  });

  test("rejoining a running turn catches up within the replay bounds", () => {
    const probe = budgetOf("rejoinProbe");
    const join = budgetOf("rejoinJoin");
    expectFlatStatements(
      ({ rejoin }) => [
        rejoin.replayed.probeStatements,
        rejoin.snapshotted.probeStatements,
      ],
      probe("statements"),
    );
    expectFlatStatements(
      ({ rejoin }) => rejoin.replayed.joinStatements,
      join("replayedStatements"),
    );
    expectFlatStatements(
      ({ rejoin }) => rejoin.snapshotted.joinStatements,
      join("snapshotStatements"),
    );
    for (const { rejoin } of [measured.short, measured.long]) {
      const { replayed, snapshotted } = rejoin;
      expect(replayed.probeBytes, report).toBeLessThanOrEqual(probe("bytes"));
      // Within the bound the join replays the log as stored.
      expect(BigInt(replayed.logEntries), report).toBeLessThanOrEqual(
        MAX_CATCHUP_CHUNKS,
      );
      expect(replayed.catchUpEvents, report).toBe(replayed.logEntries);
      expect(replayed.catchUpBytes, report).toBeLessThanOrEqual(
        join("replayedBytes"),
      );
      // Past it the join folds the stored prefix into one snapshot.
      expect(BigInt(snapshotted.logEntries), report).toBeGreaterThan(
        MAX_CATCHUP_CHUNKS,
      );
      expect(BigInt(snapshotted.catchUpEvents), report).toBeLessThanOrEqual(
        MAX_CATCHUP_CHUNKS,
      );
      expect(snapshotted.catchUpBytes, report).toBeLessThanOrEqual(
        join("snapshotBytes"),
      );
      for (const { catchUpBytes } of [replayed, snapshotted]) {
        expect(BigInt(catchUpBytes), report).toBeLessThanOrEqual(
          MAX_CATCHUP_BYTES,
        );
      }
    }
    // The catch-up is the run's, not the thread's. Its events carry the
    // thread's sequence numbers, which can be a digit wider in the long
    // thread, so the bytes may differ by that width and nothing more; every
    // count must match exactly.
    const withoutBytes = ({
      replayed,
      snapshotted,
    }: typeof measured.long.rejoin) => ({
      replayed: { ...replayed, catchUpBytes: 0 },
      snapshotted: { ...snapshotted, catchUpBytes: 0 },
    });
    expect(withoutBytes(measured.long.rejoin), report).toEqual(
      withoutBytes(measured.short.rejoin),
    );
    const SEQUENCE_WIDTH_BYTES = 8;
    for (const key of ["replayed", "snapshotted"] as const) {
      const grown =
        measured.long.rejoin[key].catchUpBytes -
        measured.short.rejoin[key].catchUpBytes;
      expect(Math.abs(grown), report).toBeLessThanOrEqual(SEQUENCE_WIDTH_BYTES);
    }
  });

  test("Stop costs a fixed number of statements", () => {
    expectFlatStatements(
      ({ rejoin }) => [
        rejoin.replayed.stopStatements,
        rejoin.snapshotted.stopStatements,
      ],
      budgetOf("stop")("statements"),
    );
  });
});
