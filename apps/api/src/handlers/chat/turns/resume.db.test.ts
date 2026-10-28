import { EventType } from "@tanstack/ai";
import type { StreamChunk, UIMessage } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

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
  USER_STOP_OUTCOME,
} from "@/api/handlers/chat/chat-turn-persistence";
import type { ChatTurnExecution } from "@/api/handlers/chat/chat-turn-persistence";
import { joinChatTurn, probeChatTurn } from "@/api/handlers/chat/turns/resume";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createChatRunLog } from "@/api/lib/chat/run-log";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { handlerFailure } from "@/api/tests/helpers/agent-skill-db";
import { buildWireSnapshot } from "@/api/tests/helpers/chat-fixtures";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

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

const ownerDb = () =>
  asTestRaw<ScopedDb>(createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1));

type SeededRun = {
  execution: ChatTurnExecution;
  runId: string;
  threadId: SafeId<"chatThread">;
};

const seedRunningTurn = async (): Promise<SeededRun> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  const messageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  seededThreads.push(threadId);
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Chat resume test",
    userId: ids.userA1,
    workspaceId: ids.wsA1,
  });
  await testDb.insert(chatMessages).values({
    id: messageId,
    threadId,
    userId: ids.userA1,
    workspaceId: ids.wsA1,
    role: "user",
    content: toPersistedChatMessageContentV3({
      data: [{ content: "Run", type: "text" }],
    }),
  });
  const acceptance = createChatTurnAcceptance({
    organizationId: ids.orgA,
    threadId,
    userId: ids.userA1,
    userMessageId: messageId,
    workspaceId: ids.wsA1,
  });
  const safeDb = toSafeDbMock(ownerDb());
  const inserted = await safeDb(
    async (tx) => await insertChatTurnAcceptanceOnTx({ acceptance, tx }),
  );
  if (Result.isError(inserted)) {
    panic("Could not seed chat turn", inserted.error);
  }
  const claimed = await claimChatTurnForExecution({
    acceptedTurnId: acceptance.id,
    incomingMessageId: messageId,
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
  const execution =
    claimed.value ?? panic("Expected seeded turn to be claimed");
  const runId = Bun.randomUUIDv7();
  const started = await startChatTurnRun({ execution, runId, safeDb });
  if (Result.isError(started)) {
    panic("Could not start seeded chat run", started.error);
  }
  expect(started.value).toBe("owned");
  return { execution, runId, threadId };
};

const logFor = ({ execution, runId }: SeededRun) =>
  createChatRunLog({
    db: ownerDb(),
    execution,
    organizationId: ids.orgA,
    runId,
  });

type Viewer = {
  db: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId?: SafeId<"workspace">;
};

const owner = (): Viewer => ({
  db: ownerDb(),
  organizationId: ids.orgA,
  userId: ids.userA1,
  workspaceId: ids.wsA1,
});

type ResumeRequest = {
  run: SeededRun;
  viewer?: Viewer;
  turnId?: SafeId<"chatTurn">;
  runId?: string;
  lastEventId?: string;
  lastEventIdHeader?: string;
};

const resumeContext = ({
  run,
  viewer = owner(),
  turnId = run.execution.id,
  runId = run.runId,
  lastEventId,
  lastEventIdHeader,
}: ResumeRequest) =>
  asTestRaw<Parameters<typeof joinChatTurn.handler>[0]>({
    getWorkspaceAccess: async (workspaceId: SafeId<"workspace">) => ({
      id: workspaceId,
      status: "active",
    }),
    memberRole: sessionMemberRole("owner"),
    params: { threadId: run.threadId, turnId },
    query: {
      ...(viewer.workspaceId === undefined
        ? {}
        : { workspaceId: viewer.workspaceId }),
      runId,
      ...(lastEventId === undefined ? {} : { lastEventId }),
    },
    request: new Request(
      `http://localhost/v1/chat/threads/${run.threadId}/turns/${turnId}/join`,
      lastEventIdHeader === undefined
        ? {}
        : { headers: { "Last-Event-ID": lastEventIdHeader } },
    ),
    route:
      "/v1/chat/threads/:threadId/turns/:turnId/join" satisfies ApiRoutePath,
    safeDb: toSafeDbMock(viewer.db),
    scopedDb: viewer.db,
    session: { activeOrganizationId: viewer.organizationId },
    set: { headers: {}, status: 200 },
    user: { id: viewer.userId },
  });

const join = async (request: ResumeRequest) => {
  const result = await joinChatTurn.handler(resumeContext(request));
  return { result, status: handlerFailure(result)?.code ?? 200 };
};

const probe = async (request: ResumeRequest) => {
  const result = await probeChatTurn.handler(resumeContext(request));
  return { result, status: handlerFailure(result)?.code ?? 200 };
};

type Delivered = { offset: string; chunk: StreamChunk };

/** Read SSE events until the one at `lastOffset`, then disconnect. */
const readUntil = async (
  response: unknown,
  lastOffset: string,
): Promise<Delivered[]> => {
  if (!(response instanceof Response)) {
    return panic("Expected a rejoin stream", response);
  }
  const reader = response.body?.getReader() ?? panic("Expected an SSE body");
  const decoder = new TextDecoder();
  const delivered: Delivered[] = [];
  let buffer = "";
  for (;;) {
    const read = await reader.read();
    if (read.done) {
      return panic("Rejoin stream ended before its last event", delivered);
    }
    buffer += decoder.decode(read.value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const lines = block.split("\n");
      const data = lines.find((line) => line.startsWith("data: "));
      if (data === undefined) {
        continue;
      }
      const offset =
        lines.find((line) => line.startsWith("id: "))?.slice(4) ??
        panic("Expected every replayed event to carry its offset", block);
      // SSE data is the JSON the run log stored for this chunk.
      const chunk = asTestRaw<StreamChunk>(JSON.parse(data.slice(6)));
      delivered.push({ offset, chunk });
      if (offset === lastOffset) {
        await reader.cancel();
        return delivered;
      }
    }
  }
};

const customChunk = (text: string): StreamChunk => ({
  type: EventType.CUSTOM,
  name: "test",
  value: { text },
});

const textMessage = (id: string, role: "user" | "assistant", text: string) =>
  ({ id, role, parts: [{ type: "text", content: text }] }) satisfies UIMessage;

/** The client-visible transcript: message identity, role and parts in order. */
const foldMessages = (
  chunks: readonly StreamChunk[],
  initialMessages: UIMessage[] = [],
) => {
  const { processor } = createStreamMessageCapture({
    initialMessages,
    capture: (message) => message,
  });
  for (const chunk of chunks) {
    processor.processChunk(chunk);
  }
  return processor
    .getMessages()
    .map(({ id, role, parts }) => ({ id, role, parts }));
};

describe("chat turn resume", () => {
  test("resume from any delivered cursor yields every later event exactly once, including events appended during the resume", async () => {
    await assertProperty(
      "resume from any delivered cursor yields every later event exactly once, including events appended during the resume",
      fc.asyncProperty(
        fc
          .tuple(
            fc.integer({ min: 1, max: 20 }),
            fc.integer({ min: 1, max: 6 }),
            fc.boolean(),
          )
          .chain(([stored, appended, viaHeader]) =>
            fc.tuple(
              fc.constant(stored),
              fc.constant(appended),
              fc.constant(viaHeader),
              // 0 stands for the "-1" cursor of a client that saw nothing.
              fc.integer({ min: 0, max: stored }),
            ),
          ),
        async ([stored, appended, viaHeader, seen]) => {
          const run = await seedRunningTurn();
          const log = logFor(run);
          const before = Array.from({ length: stored }, (_, index) =>
            customChunk(`stored ${index}`),
          );
          const during = Array.from({ length: appended }, (_, index) =>
            customChunk(`appended ${index}`),
          );
          await log.append(before);
          const cursor = seen === 0 ? "-1" : String(seen);
          const { result } = await join({
            run,
            ...(viaHeader
              ? { lastEventIdHeader: cursor }
              : { lastEventId: cursor }),
          });
          const total = stored + appended;
          const [delivered] = await Promise.all([
            readUntil(result, String(total)),
            (async () => {
              for (const value of during) {
                await log.append([value]);
              }
            })(),
          ]);
          await log.close();
          expect(delivered.map(({ offset }) => offset)).toEqual(
            Array.from({ length: total - seen }, (_, index) =>
              String(seen + index + 1),
            ),
          );
          expect(delivered.map(({ chunk }) => chunk)).toEqual(
            [...before, ...during].slice(seen),
          );
        },
      ),
      { numRuns: 12 },
    );
  });

  test("a resume gap within the event bound replays deltas and a larger gap folds into one snapshot, both reaching the full transcript in message order", async () => {
    const run = await seedRunningTurn();
    const log = logFor(run);
    const history = [
      textMessage("history-user", "user", "Earlier question"),
      textMessage("history-answer", "assistant", "Earlier answer"),
      textMessage("current-user", "user", "Current question"),
    ];
    const answerId = "current-answer";
    const deltaCount = 300;
    const chunks: StreamChunk[] = [
      { type: EventType.RUN_STARTED, threadId: run.threadId, runId: run.runId },
      buildWireSnapshot(history),
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: answerId,
        role: "assistant",
      },
      ...Array.from(
        { length: deltaCount },
        (_, index) =>
          ({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: answerId,
            delta: `${index},`,
          }) satisfies StreamChunk,
      ),
    ];
    await log.append(chunks);
    const tail = chunks.length;
    const fullTranscript = foldMessages(chunks);
    expect(fullTranscript.map(({ id }) => id)).toEqual([
      ...history.map(({ id }) => id),
      answerId,
    ]);
    // The event bound is 256 remaining entries; probe both sides of it.
    const cursors = [0, 1, 3, tail - 257, tail - 256, tail - 255, tail - 1];
    for (const seen of cursors) {
      const { result } = await join({
        run,
        lastEventId: seen === 0 ? "-1" : String(seen),
      });
      const delivered = await readUntil(result, String(tail));
      const compacted = tail - seen > 256;
      const firstType = delivered.at(0)?.chunk.type;
      expect({
        seen,
        snapshot: firstType === EventType.MESSAGES_SNAPSHOT,
      }).toEqual({
        seen,
        snapshot: compacted,
      });
      if (compacted) {
        expect(delivered).toHaveLength(1);
      } else {
        expect(delivered.map(({ chunk }) => chunk)).toEqual(chunks.slice(seen));
      }
      const resumed = foldMessages(
        delivered.map(({ chunk }) => chunk),
        // The client holds what it folded before the cursor.
        asTestRaw<UIMessage[]>(foldMessages(chunks.slice(0, seen))),
      );
      expect({ seen, resumed }).toEqual({ seen, resumed: fullTranscript });
    }
    await log.close();
  });

  test("a resume gap above the byte bound folds into a snapshot while a recent cursor over the same large log replays only its suffix", async () => {
    const run = await seedRunningTurn();
    const log = logFor(run);
    const answerId = "large-answer";
    // Three deltas of 400 KB: the whole log exceeds the 1 MiB bound, any two
    // of them do not.
    const deltas = ["a", "b", "c"].map((letter) => letter.repeat(400_000));
    const chunks: StreamChunk[] = [
      { type: EventType.RUN_STARTED, threadId: run.threadId, runId: run.runId },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: answerId,
        role: "assistant",
      },
      ...deltas.map(
        (delta) =>
          ({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: answerId,
            delta,
          }) satisfies StreamChunk,
      ),
    ];
    for (const value of chunks) {
      await log.append([value]);
    }
    const tail = String(chunks.length);
    const full = foldMessages(chunks);
    const fromStart = await readUntil(
      (await join({ run, lastEventId: "-1" })).result,
      tail,
    );
    expect(fromStart.map(({ chunk }) => chunk.type)).toEqual([
      EventType.MESSAGES_SNAPSHOT,
    ]);
    expect(foldMessages(fromStart.map(({ chunk }) => chunk))).toEqual(full);
    const recent = await readUntil(
      (await join({ run, lastEventId: "3" })).result,
      tail,
    );
    expect(recent.map(({ chunk }) => chunk)).toEqual(chunks.slice(3));
    await log.close();
  });

  test("a cursor ahead of the stored log is refused without replaying anything", async () => {
    const run = await seedRunningTurn();
    const log = logFor(run);
    await log.append([customChunk("one"), customChunk("two")]);
    for (const cursor of ["3", "999999999999999999"]) {
      const { result } = await join({ run, lastEventId: cursor });
      expect({ cursor, failure: handlerFailure(result) }).toEqual({
        cursor,
        failure: {
          code: 400,
          message: "Chat run log offset is beyond the stored tail",
        },
      });
    }
    await log.close();
  });

  test("a malformed Last-Event-ID header is refused before any replay", async () => {
    const run = await seedRunningTurn();
    const log = logFor(run);
    await log.append([customChunk("one")]);
    for (const header of ["0", "01", "abc", "-2"]) {
      const { result, status } = await join({ run, lastEventIdHeader: header });
      expect({ header, status, stream: result instanceof Response }).toEqual({
        header,
        status: 400,
        stream: false,
      });
    }
    await log.close();
  });

  test("a turn whose run ended or whose log closed resumes from the stored transcript", async () => {
    const closed = await seedRunningTurn();
    const closedLog = logFor(closed);
    await closedLog.append([customChunk("done")]);
    await closedLog.close();
    expect((await join({ run: closed, lastEventId: "1" })).result).toEqual({
      type: "transcript",
      turnId: closed.execution.id,
    });
    const settled = await seedRunningTurn();
    await logFor(settled).append([customChunk("stopped")]);
    const settledState = await ownerDb()(
      async (tx) =>
        await settleChatTurnOnTx({
          assistantMessageId: null,
          execution: settled.execution,
          outcome: USER_STOP_OUTCOME,
          tx,
        }),
    );
    expect(settledState).toBe("settled");
    for (const resume of [join, probe]) {
      expect((await resume({ run: settled, lastEventId: "1" })).result).toEqual(
        { type: "transcript", turnId: settled.execution.id },
      );
    }
  });

  test("only the thread's owner in its organization and scope can resume a running turn", async () => {
    const run = await seedRunningTurn();
    const log = logFor(run);
    await log.append([customChunk("privileged")]);
    const colleague: Viewer = {
      db: asTestRaw<ScopedDb>(
        createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA2),
      ),
      organizationId: ids.orgA,
      userId: ids.userA2,
      workspaceId: ids.wsA1,
    };
    // The owner is also a member of another organization; switching to it
    // must not reach the turn.
    const otherOrganization: Viewer = {
      db: asTestRaw<ScopedDb>(
        createScopedDb(testDb, [ids.wsB1], ids.orgB, ids.userA1),
      ),
      organizationId: ids.orgB,
      userId: ids.userA1,
      workspaceId: ids.wsB1,
    };
    const globalScope: Viewer = {
      db: ownerDb(),
      organizationId: ids.orgA,
      userId: ids.userA1,
    };
    const cases = [
      {
        name: "colleague in the same workspace",
        viewer: colleague,
        status: 404,
      },
      {
        name: "owner in another organization",
        viewer: otherOrganization,
        status: 404,
      },
      {
        name: "owner asking without the thread's workspace",
        viewer: globalScope,
        status: 400,
      },
    ];
    for (const { name, viewer, status } of cases) {
      for (const [handler, resume] of [
        ["join", join],
        ["probe", probe],
      ] as const) {
        const response = await resume({ run, viewer, lastEventId: "-1" });
        expect({
          name,
          handler,
          status: response.status,
          stream: response.result instanceof Response,
          leaked: JSON.stringify(response.result).includes("privileged"),
        }).toEqual({ name, handler, status, stream: false, leaked: false });
      }
    }
    const unknownTurn = await join({
      run,
      turnId: toSafeId<"chatTurn">(Bun.randomUUIDv7()),
      lastEventId: "-1",
    });
    expect(unknownTurn.status).toBe(404);
    expect((await probe({ run })).result).toEqual({
      type: "running",
      turnId: run.execution.id,
      runId: run.runId,
    });
    await log.close();
  });
});
