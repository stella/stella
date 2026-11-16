import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { and, asc, eq, sql } from "drizzle-orm";

import { harnessSessionId } from "@stll/agent-engine";
import { CHAT_RUN_TARGET_KIND } from "@stll/api-contract/chat-run-target";
import { DESKTOP_RUNNER_FEATURE_ID } from "@stll/api-contract/desktop-runner";
import { createTestClock, settledWithin, waitFor } from "@stll/test-kit";
import { createTestState } from "@stll/test-state";

import { member, organization, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  chatMessages,
  chatRunLogEntries,
  chatRunLogs,
  chatThreads,
  chatTurns,
  featureEnrolments,
  PROFESSIONAL_USE_ACCEPTANCE_SOURCE,
} from "@/api/db/schema";
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
  OWNER_LOST_OUTCOME,
  reapOwnerlessChatTurnOnTx,
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
import {
  CHAT_TURN_ADOPTION_SKIPPED_EVENT,
  createChatTurnAdopter,
} from "@/api/handlers/chat/turns/adopt";
import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import { createVisualResourceOrigin } from "@/api/handlers/visual-sandbox/resource-origin";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { recordAccountProfessionalUse } from "@/api/lib/auth/professional-use";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withChatRunPings } from "@/api/lib/chat/chat-run-pings";
import { answerChatTurnAdopterDoorbell } from "@/api/lib/chat/chat-turn-handover-doorbell";
import { createContextNoticeStamp } from "@/api/lib/chat/context-notice";
import { resolveServerStartedMember } from "@/api/lib/chat/server-started-member";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import { logger } from "@/api/lib/observability/logger";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createComputer,
  harnessChunks,
} from "@/api/tests/helpers/fake-local-computer";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// Runs as a postgres suite against the database the root pool reaches: the
// adopting task proves its member again through that pool, as a task
// started on the server does, and then works on the member's own
// connection, so every row the turn needs is written there too.
//
// The owner of a running local turn stops: an API task with a member's
// computer working on the turn, stopped through the path its shutdown takes,
// while another task listens for released turns. The computer never stops,
// the other task finishes the turn, and the thread and its viewers end with
// the one answer a single task would have produced.

const testState = createTestState({ file: import.meta.path, config: env });

const db = rootDb;
const clock = createTestClock();

/** A member of the fixture organization, and their own connection. */
type Member = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  safeDb: SafeDb;
};

const organizationId = mintAuthProviderId<"organization">();
const memberIds: SafeId<"user">[] = [];
/** Runs turns on their computer throughout. */
let staying: Member;
/** Leaves the organization while a turn of theirs waits for a task. */
let leaving: Member;

/**
 * A member who may run chat turns on their computer: verified, accepted
 * professional use as any signed-in request has, enrolled in the feature.
 */
const seedMember = async (): Promise<Member> => {
  const userId = mintAuthProviderId<"user">();
  memberIds.push(userId);
  await db.insert(user).values({
    id: userId,
    name: "Handover fixture",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  const accepted = await recordAccountProfessionalUse({
    userId,
    source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.interactive,
  });
  expect(accepted.isOk()).toBe(true);
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "member",
    createdAt: new Date(clock.now()),
  });
  await db.insert(featureEnrolments).values({
    featureId: DESKTOP_RUNNER_FEATURE_ID,
    organizationId,
    userId,
  });
  const resolved = await resolveServerStartedMember({
    organizationId,
    userId,
    work: {
      type: "turn-handover",
      threadId: toSafeId<"chatThread">(Bun.randomUUIDv7()),
      turnId: toSafeId<"chatTurn">(Bun.randomUUIDv7()),
    },
    signal: new AbortController().signal,
  });
  const proved = resolved.isOk()
    ? resolved.value
    : panic("Could not prove the fixture member", resolved.error);
  if (proved.type !== "member") {
    return panic("The fixture member was not proved");
  }
  return { organizationId, userId, safeDb: proved.caller.safeDb };
};

const noAudit: AuditRecorder = async () => {
  await Promise.resolve();
};

const QUESTION = "Run the test suite";
/** Each step's bound, so a stuck step names itself before the test's own. */
const STEP_TIMEOUT_MS = 8000;

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

/** A new thread of `owner`'s whose first turn a send claimed for its run. */
const seedClaimedTurn = async (owner: Member) => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  const userMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  const question = { content: QUESTION, type: "text" } as const;
  await db.insert(chatThreads).values({
    id: threadId,
    organizationId: owner.organizationId,
    title: extractTitle([question]),
    userId: owner.userId,
    workspaceId: null,
  });
  await db.insert(chatMessages).values({
    id: userMessageId,
    threadId,
    userId: owner.userId,
    workspaceId: null,
    role: "user",
    content: toPersistedChatMessageContentV3({ data: [question] }),
  });
  const acceptance = createChatTurnAcceptance({
    source: { type: "member" },
    organizationId: owner.organizationId,
    threadId,
    userId: owner.userId,
    userMessageId,
    workspaceId: null,
  });
  const { safeDb } = owner;
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
    organizationId: owner.organizationId,
    safeDb,
    threadId,
    userId: owner.userId,
    workspaceId: null,
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
  return { execution, owner, runId, threadId, userMessage };
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
  const { owner } = seeded;
  const { safeDb } = owner;
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
      userId: owner.userId,
      workspaceId: null,
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
    organizationId: owner.organizationId,
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
  (await db.select().from(chatTurns).where(eq(chatTurns.id, turnId))).at(0) ??
  panic("Expected the turn row");

const readLog = async (runId: string): Promise<StreamChunk[]> =>
  (
    await db
      .select({ chunk: chatRunLogEntries.chunk })
      .from(chatRunLogEntries)
      .where(
        and(
          eq(chatRunLogEntries.organizationId, organizationId),
          eq(chatRunLogEntries.runId, runId),
        ),
      )
      .orderBy(asc(chatRunLogEntries.seq))
  ).map(({ chunk }) => asTestRaw<StreamChunk>(chunk));

const readAnswer = async (messageId: SafeId<"chatMessage">) => {
  const [row] = await db
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
    if (part.type === "text") {
      return ["text", part.content];
    }
    if (part.type === "tool-call") {
      return ["tool-call", part.name, part.arguments, part.state];
    }
    if (part.type === "tool-result") {
      return ["tool-result", part.toolCallId, part.state];
    }
    return [part.type];
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

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("an owner stop mid-turn (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("an owner stop mid-turn (postgres)", () => {
    testState.beforeAll(async () => {
      await db.insert(organization).values({
        id: organizationId,
        name: "Handover fixture",
        slug: organizationId,
        createdAt: new Date(clock.now()),
      });
      await recordNewOrganizationAccessState(db, {
        organizationId,
        now: new Date(clock.now()),
      });
      testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
        [DESKTOP_RUNNER_FEATURE_ID]: [{ type: "organization", organizationId }],
      });
      staying = await seedMember();
      leaving = await seedMember();
    });

    afterAll(async () => {
      await db
        .delete(chatThreads)
        .where(eq(chatThreads.organizationId, organizationId));
      await db
        .delete(featureEnrolments)
        .where(eq(featureEnrolments.organizationId, organizationId));
      await deleteOrganizationsForTest(db, [organizationId]);
      for (const userId of memberIds) {
        await db.delete(user).where(eq(user.id, userId));
      }
    });

    test("hands the turn to another task, which finishes the one answer while the computer runs on", async () => {
      const { before, after } = await turnHalves();
      const whole = await uninterrupted([...before, ...after]);
      const seeded = await seedClaimedTurn(staying);
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
      await settledWithin(caughtUp.promise, {
        description: "the owner's read to catch up with the computer",
        timeoutMs: STEP_TIMEOUT_MS,
      });

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
          releasedTurn.assistantMessageId ??
          panic("Expected the answer so far");
        released.answerId = checkpointId;
        expect(
          sayings((await readAnswer(checkpointId)).parts).flat(),
        ).toContain("Running the tests. ");
        const [log] = await db
          .select({ closedAt: chatRunLogs.closedAt })
          .from(chatRunLogs)
          .where(eq(chatRunLogs.runId, seeded.runId));
        expect(log?.closedAt).toBeNull();

        // The computer works on through the gap and finishes the turn.
        computer.events(after);
        computer.finish();
        await settledWithin(Promise.all(adoptions), {
          description: "the rung task to take the turn",
          timeoutMs: STEP_TIMEOUT_MS,
        });
        expect(adoptions).toHaveLength(1);
        // Taken: the rung task's claim moved the turn back to running.
        expect((await readTurn(seeded.execution.id)).status).not.toBe(
          "handed-over",
        );
        await waitFor(
          async () => {
            const turn = await readTurn(seeded.execution.id);
            return turn.status === "running" || turn.status === "handed-over"
              ? undefined
              : turn;
          },
          {
            description: "the adopted turn's end",
            timeoutMs: STEP_TIMEOUT_MS,
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
      const seeded = await seedClaimedTurn(staying);
      await db
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
        safeDb: staying.safeDb,
        threadId: seeded.threadId,
        userId: staying.userId,
        workspaceId: null,
      });

      expect(released.isOk() ? released.value.type : released.error).toBe(
        "stopped",
      );
      const turn = await readTurn(seeded.execution.id);
      expect(turn.status).toBe("cancelled");
      expect(turn.cancellationReason).toBe("user-stop");
    });

    test("that cannot act for the turn's member says why, and the turn ends as owner-lost at its adopt-by", async () => {
      const seeded = await seedClaimedTurn(leaving);
      const turnId = seeded.execution.id;
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
        safeDb: leaving.safeDb,
        threadId: seeded.threadId,
        userId: leaving.userId,
        workspaceId: null,
      });
      expect(released.isOk() ? released.value.type : released.error).toBe(
        "handed-over",
      );
      const checkpointId =
        (await readTurn(turnId)).assistantMessageId ??
        panic("Expected the answer so far");
      // The member leaves the organization before a task is rung for the
      // turn; its rows stay theirs.
      await db
        .delete(member)
        .where(
          and(
            eq(member.organizationId, organizationId),
            eq(member.userId, leaving.userId),
          ),
        );

      const computer = createComputer();
      const adopter = createChatTurnAdopter({
        signal: new AbortController().signal,
        indexThread: async () => {},
        ownership: new ChatTurnOwnership(),
        runtime: {
          control: asTestRaw<DesktopRunnerControl>(computer.context.control),
          runBell: computer.context.runBell,
        },
        answerQuoteChecker: NO_ANSWER_QUOTE_CHECKER,
      });
      const warned = spyOn(logger, "warn");
      try {
        await settledWithin(
          adopter.adopt({
            organizationId,
            threadId: seeded.threadId,
            turnId,
            userId: leaving.userId,
          }),
          {
            description: "the rung task to skip the turn",
            timeoutMs: STEP_TIMEOUT_MS,
          },
        );
        expect(warned).toHaveBeenCalledWith(CHAT_TURN_ADOPTION_SKIPPED_EVENT, {
          organizationId,
          reason: "member-unavailable",
          threadId: seeded.threadId,
          turnId,
        });
      } finally {
        warned.mockRestore();
      }
      // Skipped, not taken: the turn waits for its adopt-by.
      const waiting = await readTurn(turnId);
      expect(waiting.status).toBe("handed-over");
      expect(waiting.executionId).toBeNull();

      // Nobody adopts it by then; the reaper ends it as a vanished owner's,
      // through the settlement its scheduled run applies to each thread.
      await db
        .update(chatTurns)
        .set({
          leaseExpiresAt: sql`${chatTurns.createdAt} + interval '1 millisecond'`,
        })
        .where(eq(chatTurns.id, turnId));
      await withChatRunPings(
        async (pings) =>
          await db.transaction(
            async (tx) =>
              await reapOwnerlessChatTurnOnTx({
                pings,
                threadId: seeded.threadId,
                tx,
              }),
          ),
      );
      const ended = await readTurn(turnId);
      expect(ended.status).toBe("interrupted");
      expect(ended.interruptionReason).toBe(OWNER_LOST_OUTCOME.reason);
      expect((await readAnswer(checkpointId)).metadata?.turnOutcome).toEqual(
        OWNER_LOST_OUTCOME,
      );
    });
  });
}
