import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { harnessSessionId } from "@stll/agent-engine";
import { CHAT_RUN_TARGET_KIND } from "@stll/api-contract/chat-run-target";
import { DESKTOP_RUNNER_FEATURE_ID } from "@stll/api-contract/desktop-runner";
import { waitFor } from "@stll/test-kit";
import { createTestState } from "@stll/test-state";

import { user } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  chatMessages,
  chatRunLogEntries,
  chatRunLogs,
  chatThreads,
  chatTurns,
  featureEnrolments,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import {
  type AnswerQuoteChecker,
  NO_ANSWER_QUOTE_CHECKER,
} from "@/api/handlers/chat/answer-quote-checks";
import {
  chatMessageFromPersisted,
  toPersistableChatMessage,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import { persistHandedOverChatTurn } from "@/api/handlers/chat/chat-message-persistence";
import { extractTitle } from "@/api/handlers/chat/chat-prompt";
import { createChatTurnBudget } from "@/api/handlers/chat/chat-turn-budget";
import {
  bindChatTurnRunId,
  claimChatTurnForExecution,
  createChatTurnAcceptance,
  insertChatTurnAcceptanceOnTx,
} from "@/api/handlers/chat/chat-turn-persistence";
import {
  CHAT_TURN_BOUNDARY_MODE,
  ChatTurnOwnership,
  chatTurnRelinquishmentOf,
  ChatTurnRun,
  chatTurnRunBoundOf,
} from "@/api/handlers/chat/chat-turn-run";
import {
  knownDecisionPassageStamper,
  NO_DECISION_PASSAGE_NUMBERS,
} from "@/api/handlers/chat/decision-passage-numbers";
import { createLocalChatRun } from "@/api/handlers/chat/local-run-chunks";
import {
  processServerChatStream,
  produceChatTurn,
  toChatMessage,
} from "@/api/handlers/chat/stream-chat";
import { createChatMessageIdMapper } from "@/api/handlers/chat/stream-message-identity";
import { createChatTurnAdopter } from "@/api/handlers/chat/turns/adopt";
import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import { createVisualResourceOrigin } from "@/api/handlers/visual-sandbox/resource-origin";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withChatRunPings } from "@/api/lib/chat/chat-run-pings";
import { answerChatTurnAdopterDoorbell } from "@/api/lib/chat/chat-turn-handover-doorbell";
import { createContextNoticeStamp } from "@/api/lib/chat/context-notice";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import {
  createComputer,
  harnessChunks,
} from "@/api/tests/helpers/fake-local-computer";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { HAPPY_PATH_TIMEOUT_MS } from "@/api/tests/test-timeouts";

// The owner of a running local turn stops: an API task with a member's
// computer working on the turn, stopped through the path its shutdown takes,
// while another task listens for released turns. The computer never stops,
// the other task finishes the turn, and the thread and its viewers end with
// the one answer a single task would have produced.

const testState = createTestState({ file: import.meta.path, config: env });

let testDb: TestDatabase;
let ids: TestIds;
const seededThreads: SafeId<"chatThread">[] = [];
let emailVerifiedBefore = false;

testState.beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  // The member may run chat turns on their computer.
  const [member] = await testDb
    .select({ emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, ids.userA1));
  emailVerifiedBefore = member?.emailVerified ?? false;
  await testDb
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, ids.userA1));
  await testDb
    .insert(featureEnrolments)
    .values({
      featureId: DESKTOP_RUNNER_FEATURE_ID,
      organizationId: ids.orgA,
      userId: ids.userA1,
    })
    .onConflictDoNothing();
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    [DESKTOP_RUNNER_FEATURE_ID]: [
      { type: "organization", organizationId: ids.orgA },
    ],
  });
});

afterAll(async () => {
  if (seededThreads.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreads));
  }
  await testDb
    .delete(featureEnrolments)
    .where(
      and(
        eq(featureEnrolments.featureId, DESKTOP_RUNNER_FEATURE_ID),
        eq(featureEnrolments.organizationId, ids.orgA),
        eq(featureEnrolments.userId, ids.userA1),
      ),
    );
  await testDb
    .update(user)
    .set({ emailVerified: emailVerifiedBefore })
    .where(eq(user.id, ids.userA1));
  await releaseRlsFixture();
});

const safeDbOf = () =>
  toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    ),
  );

const noAudit: AuditRecorder = async () => {
  await Promise.resolve();
};

const QUESTION = "Run the test suite";

const toolCall = {
  id: "item_9",
  name: "command_execution",
  input: { command: "bun test" },
};

/** The computer's turn, split where the owner stops. */
const turnHalves = async () => {
  const before = await harnessChunks([
    {
      type: "session.started",
      sessionId: harnessSessionId("session-handover"),
      continuation: { type: "fresh" },
    },
    { type: "text.delta", messageId: "answer", delta: "Running the tests. " },
  ]);
  const after = await harnessChunks([
    { type: "tool.started", toolCall },
    {
      type: "tool.completed",
      toolCall,
      result: { content: "12 pass", status: "succeeded" },
    },
    { type: "text.delta", messageId: "answer", delta: "All tests pass." },
    {
      type: "text.completed",
      messageId: "answer",
      text: "Running the tests. All tests pass.",
    },
    { type: "turn.completed", usage: null, boundary: null },
  ]);
  return { before, after };
};

/** A new thread whose first turn a send claimed for its run. */
const seedClaimedTurn = async () => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  const userMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  seededThreads.push(threadId);
  const question = { content: QUESTION, type: "text" } as const;
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: extractTitle([question]),
    userId: ids.userA1,
    workspaceId: ids.wsA1,
  });
  await testDb.insert(chatMessages).values({
    id: userMessageId,
    threadId,
    userId: ids.userA1,
    workspaceId: ids.wsA1,
    role: "user",
    content: toPersistedChatMessageContentV3({ data: [question] }),
  });
  const acceptance = createChatTurnAcceptance({
    source: { type: "member" },
    organizationId: ids.orgA,
    threadId,
    userId: ids.userA1,
    userMessageId,
    workspaceId: ids.wsA1,
  });
  const safeDb = safeDbOf();
  const inserted = await withChatRunPings(
    async (pings) =>
      await safeDb(
        async (tx) =>
          await insertChatTurnAcceptanceOnTx({ pings, acceptance, tx }),
      ),
  );
  if (Result.isError(inserted)) {
    return panic("Could not seed the turn", inserted.error);
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
  const execution = Result.isOk(claimed)
    ? (claimed.value ?? panic("The seeded turn was not claimed"))
    : panic("Could not claim the seeded turn", claimed.error);
  const runId = `chat-run-${execution.id}`;
  const bound = await bindChatTurnRunId({ execution, runId, safeDb });
  if (Result.isError(bound)) {
    return panic("Could not bind the turn's run", bound.error);
  }
  const userMessage: ChatMessage = {
    id: userMessageId,
    parts: [question],
    role: "user",
  };
  return { execution, runId, threadId, userMessage };
};

type SeededTurn = Awaited<ReturnType<typeof seedClaimedTurn>>;

/**
 * The task that started the turn: its run reads the computer and pumps the
 * turn's log. Nothing settles the turn here; this task only releases it.
 */
const startOwner = async ({
  computer,
  seeded,
}: {
  computer: ReturnType<typeof createComputer>;
  seeded: SeededTurn;
}) => {
  const ownership = new ChatTurnOwnership();
  const safeDb = safeDbOf();
  const run = new ChatTurnRun({
    ownership,
    connectors: undefined,
    bound: chatTurnRunBoundOf(CHAT_RUN_TARGET_KIND.local),
    mode: CHAT_TURN_BOUNDARY_MODE.rawOverride,
    owner: {
      indexThread: async () => {},
      execution: seeded.execution,
      owningAssistantMessage: undefined,
      recordAuditEvent: noAudit,
      safeDb,
      threadId: seeded.threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    },
  });
  const settledHere: unknown[] = [];
  const production = produceChatTurn({
    source: createLocalChatRun(
      { ...computer.context, chatThreadId: seeded.threadId },
      {
        type: "start",
        target: {
          kind: "local",
          harness: "codex",
          model: "local-model",
          approvals: "ask",
          reasoningEffort: null,
        },
      },
    ).stream({
      chatRunId: seeded.runId,
      chatTurnId: seeded.execution.id,
      messages: [],
      instructions: "You are stella.",
      resume: undefined,
      abortSignal: run.control.abortController.signal,
      handOverSignal: run.control.handOverSignal,
    }),
    run,
    safeDb,
    organizationId: ids.orgA,
    runId: seeded.runId,
    threadId: seeded.threadId,
    thirdPartyBoundary: { type: "raw" },
    latestMessageId: seeded.userMessage.id,
    initialMessages: [seeded.userMessage],
    restorationPairs: [],
    owningAssistantMessageId: undefined,
    turnBudget: createChatTurnBudget({ owningMessage: undefined }),
    contextNotice: createContextNoticeStamp(null),
    dismissesAwaited: false,
    answerSoFar: "none",
    stampAnswer: (message) => message,
    storedHistory: {
      rewrittenOnAcceptance: [],
      loadServed: () => panic("A local run carries no messages snapshot"),
    },
    visualOrigin: createVisualResourceOrigin({ persistedParts: [] }),
    decisionPassageStamper: knownDecisionPassageStamper(
      NO_DECISION_PASSAGE_NUMBERS,
    ),
    answerQuoteChecker: NO_ANSWER_QUOTE_CHECKER,
    resolveAssistantTextRefs: undefined,
    resolveAssistantToolInputRefs: undefined,
    resolveAssistantToolOutputRefs: undefined,
    resolveAssistantValueRefs: undefined,
    onFinish: async (event) => {
      settledHere.push(event);
      return await Promise.resolve({ type: "not-owned" });
    },
  });
  await run.pump(production.output, production.durability);
  return { ownership, settledHere };
};

const readTurn = async (turnId: SafeId<"chatTurn">) =>
  (await testDb.query.chatTurns.findFirst({ where: { id: { eq: turnId } } })) ??
  panic("Expected the turn row");

const readLog = async (runId: string): Promise<StreamChunk[]> =>
  (
    await testDb
      .select({ chunk: chatRunLogEntries.chunk })
      .from(chatRunLogEntries)
      .where(
        and(
          eq(chatRunLogEntries.organizationId, ids.orgA),
          eq(chatRunLogEntries.runId, runId),
        ),
      )
      .orderBy(asc(chatRunLogEntries.seq))
  ).map(({ chunk }) => asTestRaw<StreamChunk>(chunk));

const readAnswer = async (messageId: SafeId<"chatMessage">) => {
  const [row] = await testDb
    .select({
      content: chatMessages.content,
      id: chatMessages.id,
      role: chatMessages.role,
    })
    .from(chatMessages)
    .where(eq(chatMessages.id, messageId));
  return chatMessageFromPersisted(row ?? panic("Expected the stored answer"));
};

/** What an answer says, without the bookkeeping each store adds. */
const sayings = (parts: readonly ChatPart[]) =>
  parts.map((part) => {
    switch (part.type) {
      case "text":
        return ["text", part.content];
      case "tool-call":
        return ["tool-call", part.name, part.arguments, part.state];
      case "tool-result":
        return ["tool-result", part.toolCallId, part.state];
      default:
        return [part.type];
    }
  });

/** The answer a page builds from the chunks of a turn's log. */
const pageAnswer = (chunks: readonly StreamChunk[]) => {
  const { processor, message } = createStreamMessageCapture({
    initialMessages: [],
    capture: toChatMessage,
  });
  for (const chunk of chunks) {
    processor.processChunk(chunk);
  }
  processor.finalizeStream();
  return message() ?? panic("The page built no answer");
};

/** The answer and the chunks one task reading the whole turn produces. */
const uninterrupted = async (chunks: readonly StreamChunk[]) => {
  const computer = createComputer();
  computer.events(chunks);
  computer.finish();
  const { processor, message } = createStreamMessageCapture({
    initialMessages: [],
    capture: toChatMessage,
  });
  const emitted: PublicStreamChunk[] = [];
  const finished: { answer?: ChatMessage } = {};
  const never = new AbortController().signal;
  for await (const chunk of processServerChatStream({
    abortSignal: never,
    deadlineSignal: never,
    getResponseMessage: message,
    initialMessages: [],
    mapMessageId: createChatMessageIdMapper(() =>
      toSafeId<"chatMessage">(Bun.randomUUIDv7()),
    ),
    processor,
    source: createLocalChatRun(computer.context, {
      type: "start",
      target: {
        kind: "local",
        harness: "codex",
        model: "local-model",
        approvals: "ask",
        reasoningEffort: null,
      },
    }).stream({
      chatRunId: "chat-run-whole",
      chatTurnId: toSafeId<"chatTurn">(Bun.randomUUIDv7()),
      messages: [],
      instructions: "You are stella.",
      resume: undefined,
      abortSignal: never,
      handOverSignal: never,
    }),
    onFinish: ({ responseMessage }) => {
      finished.answer = responseMessage;
    },
  })) {
    emitted.push(chunk);
  }
  return {
    answer: finished.answer ?? panic("The whole turn did not finish"),
    page: pageAnswer(emitted),
  };
};

describe("an owner stop mid-turn", () => {
  test("hands the turn to another task, which finishes the one answer while the computer runs on", async () => {
    const { before, after } = await turnHalves();
    const whole = await uninterrupted([...before, ...after]);
    const seeded = await seedClaimedTurn();
    const computer = createComputer();
    computer.events(before);
    // The owner's read asks for the run's state once it read every stored
    // event: the owner is mid-turn, waiting on the computer.
    const caughtUp = Promise.withResolvers<undefined>();
    const { control } = computer.context;
    computer.context.control = {
      ...control,
      readRun: async (options) => {
        caughtUp.resolve(undefined);
        return await control.readRun(options);
      },
    };
    const owner = await startOwner({ computer, seeded });
    await caughtUp.promise;

    // Another task listens for released turns, with the steps a completed
    // turn takes after it settles in the test's hand.
    const stopping = new AbortController();
    const titled: unknown[] = [];
    const markedDue: unknown[] = [];
    const quoteChecked: unknown[] = [];
    const quoteChecker: AnswerQuoteChecker = async (message) => {
      quoteChecked.push(message.parts.length);
      return await NO_ANSWER_QUOTE_CHECKER(message);
    };
    const adopter = createChatTurnAdopter({
      signal: stopping.signal,
      indexThread: async () => {},
      ownership: new ChatTurnOwnership(),
      runtime: {
        control: asTestRaw<DesktopRunnerControl>(computer.context.control),
        runBell: computer.context.runBell,
      },
      answerQuoteChecker: quoteChecker,
      followUps: {
        markCompactionDue: async (options) => {
          markedDue.push(options.threadId);
          await Promise.resolve();
        },
        generateTitle: async (options) => {
          titled.push(options);
          await Promise.resolve();
        },
      },
    });
    const adoptions: Promise<void>[] = [];
    const released: { answerId?: SafeId<"chatMessage"> } = {};
    const stopAnswering = answerChatTurnAdopterDoorbell((turn) => {
      adoptions.push(adopter.adopt(turn));
    });
    try {
      // The owner's process stops, as its shutdown gives up its turns.
      expect(
        await owner.ownership.relinquish(chatTurnRelinquishmentOf(true)),
      ).toBe("stored");
      expect(owner.settledHere).toEqual([]);
      const releasedTurn = await readTurn(seeded.execution.id);
      expect(releasedTurn.status).toBe("handed-over");
      expect(releasedTurn.executionId).toBeNull();
      const checkpointId =
        releasedTurn.assistantMessageId ?? panic("Expected the answer so far");
      released.answerId = checkpointId;
      expect(sayings((await readAnswer(checkpointId)).parts).flat()).toContain(
        "Running the tests. ",
      );
      const [log] = await testDb
        .select({ closedAt: chatRunLogs.closedAt })
        .from(chatRunLogs)
        .where(eq(chatRunLogs.runId, seeded.runId));
      expect(log?.closedAt).toBeNull();

      // The computer works on through the gap and finishes the turn.
      computer.events(after);
      computer.finish();
      await Promise.all(adoptions);
      expect(adoptions).toHaveLength(1);
      await waitFor(
        async () => {
          const turn = await readTurn(seeded.execution.id);
          return turn.status === "running" || turn.status === "handed-over"
            ? undefined
            : turn;
        },
        {
          description: "the adopted turn's end",
          timeoutMs: HAPPY_PATH_TIMEOUT_MS,
        },
      );
    } finally {
      stopAnswering();
      stopping.abort();
    }

    const ended = await readTurn(seeded.execution.id);
    expect(ended.status).toBe("completed");
    // The adopter continued the stored answer under its id.
    expect(ended.assistantMessageId).toBe(released.answerId ?? null);
    const stored = await readAnswer(
      ended.assistantMessageId ?? panic("Expected the stored answer"),
    );
    expect(sayings(stored.parts)).toEqual(sayings(whole.answer.parts));
    // The adopter checked the answer's quotes, as the send would have.
    expect(quoteChecked).toHaveLength(1);

    // A page that tails the turn's log through the gap shows the same answer
    // as one that watched a single task, with one run start and one end.
    const logged = await readLog(seeded.runId);
    expect(sayings(pageAnswer(logged).parts)).toEqual(
      sayings(whole.page.parts),
    );
    expect(
      logged.filter((chunk) => chunk.type === EventType.RUN_STARTED),
    ).toHaveLength(1);
    const ends = logged.flatMap((chunk, index) =>
      chunk.type === EventType.RUN_FINISHED ||
      chunk.type === EventType.RUN_ERROR
        ? [index]
        : [],
    );
    expect(ends).toEqual([logged.length - 1]);

    // The computer was never told to stop.
    expect(computer.queued.interrupts).toBe(0);

    // A completed first turn: compaction was considered and the new thread
    // is titled from its question and the answer.
    expect(markedDue).toEqual([seeded.threadId]);
    expect(titled).toEqual([
      expect.objectContaining({
        initialTitle: extractTitle(seeded.userMessage.parts),
        threadId: seeded.threadId,
      }),
    ]);
  });

  test("that finds the member's stop recorded first ends the turn as that stop", async () => {
    const seeded = await seedClaimedTurn();
    await testDb
      .update(chatTurns)
      .set({ cancelRequestedAt: sql`now()` })
      .where(eq(chatTurns.id, seeded.execution.id));

    const released = await persistHandedOverChatTurn({
      execution: seeded.execution,
      indexThread: async () => {},
      owningAssistantMessage: undefined,
      recordAuditEvent: noAudit,
      responseMessage: toPersistableChatMessage({
        id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
        parts: [{ content: "Running the tests. ", type: "text" }],
        role: "assistant",
      }),
      safeDb: safeDbOf(),
      threadId: seeded.threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    });

    expect(released.isOk() ? released.value.type : released.error).toBe(
      "stopped",
    );
    const turn = await readTurn(seeded.execution.id);
    expect(turn.status).toBe("cancelled");
    expect(turn.cancellationReason).toBe("user-stop");
  });
});
