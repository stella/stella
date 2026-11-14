import { EventType, memoryStream } from "@tanstack/ai";
import type { RunAgentResumeItem, StreamChunk } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  type HarnessEvent,
  harnessEventsToChunks,
  harnessSessionId,
} from "@stll/agent-engine";
import {
  CHAT_LOCAL_RUN_COMPUTER_EVENT,
  CHAT_RUN_TARGET_KIND,
  type ChatRunTarget,
} from "@stll/api-contract/chat-run-target";
import { DESKTOP_RUNNER_DESKTOP_MESSAGE } from "@stll/api-contract/desktop-runner";

import { toSafeId } from "@/api/lib/branded-types";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import { createLocalRunBell } from "@/api/lib/desktop-runner/doorbell";
import type {
  DesktopRunnerRunView,
  StoredRunEvent,
} from "@/api/lib/desktop-runner/store";
import { isRecord } from "@/api/lib/type-guards";
import { withTimeout } from "@/api/lib/with-timeout";
import { HELD_TEST_STREAM_BINDING } from "@/api/tests/helpers/sse-stream-binding";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";
import { HAPPY_PATH_TIMEOUT_MS } from "@/api/tests/test-timeouts";

import { CHAT_METERED_PROVIDER_TIMEOUT_MS } from "./chat-turn-persistence";
import {
  ChatTurnOwnership,
  ChatTurnRun,
  chatTurnRunBoundOf,
} from "./chat-turn-run";
import { createLocalChatRun } from "./local-run-chunks";
import type { LocalRunContext } from "./local-run-chunks";
import { processServerChatStream, toChatMessage } from "./stream-chat";
import { createChatMessageIdMapper } from "./stream-message-identity";
import type { ChatTurnOutcome } from "./types";

const HOUR_MS = 60 * 60 * 1000;
const RUNNER_RUN_ID = "0198c0de-0000-7000-8000-000000000001";
const REQUEST_ID = "0198c0de-0000-7000-8000-000000000002";
const THREAD_ID = toSafeId<"chatThread">("thread_bound");
const TURN_ID = toSafeId<"chatTurn">("turn_bound");
const DESTINATION = {
  desktopId: "0198c0de-0000-7000-8000-000000000003",
  harness: "codex",
  harnessVersion: "1.0.0",
  model: "local-model",
  reasoningEffort: null,
  approvals: "ask",
  linkedFolderId: null,
} as const;

/**
 * The deadlines a run arms, fired by the test's own time instead of a timer:
 * advancing past a deadline aborts its signal as `AbortSignal.timeout` would.
 */
const createDeadlineClock = () => {
  let now = 0;
  const armed: { at: number; controller: AbortController }[] = [];
  return {
    createDeadlineSignal: (deadlineMs: number) => {
      const controller = new AbortController();
      armed.push({ at: now + deadlineMs, controller });
      return controller.signal;
    },
    advance: (elapsedMs: number) => {
      now += elapsedMs;
      for (const { at, controller } of armed) {
        if (at <= now && !controller.signal.aborted) {
          controller.abort(
            new DOMException("The operation timed out.", "TimeoutError"),
          );
        }
      }
    },
    armed: () => armed.length,
  };
};

/** The chunks the desktop's own mapper makes of a harness turn. */
const harnessChunks = async (events: HarnessEvent[]) => {
  let generated = 0;
  const chunks: StreamChunk[] = [];
  for await (const chunk of harnessEventsToChunks(
    (async function* () {
      yield* events;
    })(),
    {
      harness: "codex",
      model: DESTINATION.model,
      runId: RUNNER_RUN_ID,
      threadId: "desktop-thread",
      workspaceDir: "/workspace",
      generateId: () => {
        generated += 1;
        return `generated-${String(generated)}`;
      },
      now: () => 0,
    },
  )) {
    chunks.push(chunk);
  }
  return chunks;
};

const isPause = (chunk: StreamChunk) =>
  chunk.type === EventType.RUN_FINISHED && chunk.outcome?.type === "interrupt";

/**
 * The member's computer as the turn reads it: the run's stored messages, its
 * state as the runner gateway keeps it, and the commands the turn queued.
 */
const createComputer = () => {
  const runBell = createLocalRunBell();
  const stored: StoredRunEvent[] = [];
  const queued = { interrupts: 0, approvals: 0 };
  let state: DesktopRunnerRunView["state"] = "running";
  let chatReadSeq = 0;
  let approvalRequest: StoredRunEvent | undefined;
  const store = (message: (seq: number) => Record<string, unknown>) => {
    const seq = stored.length + 1;
    const event = { seq, message: { ...message(seq), runId: RUNNER_RUN_ID } };
    stored.push(event);
    runBell.ring(RUNNER_RUN_ID);
    return event;
  };
  const control: LocalRunContext["control"] = {
    readChatRunSession: async () => Result.ok(null),
    startRun: async () => Result.ok({ type: "assigned", runId: RUNNER_RUN_ID }),
    readEvents: async ({ afterSeq }) =>
      Result.ok({
        items: stored.filter(({ seq }) => seq > afterSeq),
        nextAfterSeq: null,
      }),
    readRun: async () =>
      Result.ok({
        runId: RUNNER_RUN_ID,
        desktopId: DESTINATION.desktopId,
        harness: DESTINATION.harness,
        harnessVersion: DESTINATION.harnessVersion,
        state,
        outcome: null,
        rejectReason: null,
        harnessSessionId: null,
        ackSeq: stored.length,
        leaseExpiresAt: new Date(0),
        createdAt: new Date(0),
        deliveredAt: new Date(0),
        lostReason: null,
        acceptedAt: new Date(0),
      }),
    interruptRun: async () => {
      queued.interrupts += 1;
      return Result.ok({ type: "queued" });
    },
    recordChatReadSeq: async ({ seq }) => {
      chatReadSeq = seq;
      return Result.ok(undefined);
    },
    readChatRunForRequest: async () =>
      Result.ok(
        approvalRequest === undefined
          ? null
          : {
              runId: RUNNER_RUN_ID,
              harness: DESTINATION.harness,
              state,
              chatReadSeq,
              askedBy: DESKTOP_RUNNER_DESKTOP_MESSAGE.runApprovalRequest,
              request: approvalRequest.message,
            },
      ),
    answerApproval: async () => {
      queued.approvals += 1;
      return Result.ok({ type: "queued" });
    },
    answerQuestion: async () => panic("No question is asked here"),
    pairAppCall: async () => panic("No app call is reported here"),
    readRunOutputFile: async () => panic("No output file is reported here"),
  };
  const context: LocalRunContext = {
    control,
    runBell,
    owner: {
      userId: toSafeId<"user">("user_bound"),
      organizationId: toSafeId<"organization">("org_bound"),
    },
    chatThreadId: THREAD_ID,
    workspaceIds: [],
    mcp: { serverName: "stella", url: "https://stella.test/mcp" },
    // Every change rings; the poll only bounds a missed ring.
    pollMs: 20,
  };
  return {
    context,
    queued,
    chatReadSeq: () => chatReadSeq,
    events: (chunks: readonly StreamChunk[]) => {
      for (const chunk of chunks) {
        store((seq) => ({
          type: DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent,
          seq,
          chunk,
        }));
      }
    },
    approvalRequest: () => {
      approvalRequest = store((seq) => ({
        type: DESKTOP_RUNNER_DESKTOP_MESSAGE.runApprovalRequest,
        seq,
        requestId: REQUEST_ID,
        kind: "command",
        summary: "Run the test suite",
      }));
    },
    finish: () => {
      state = "finished";
      store((seq) => ({
        type: DESKTOP_RUNNER_DESKTOP_MESSAGE.runFinished,
        seq,
        outcome: "completed",
        harnessSessionId: null,
      }));
    },
    /** What the gateway's sweep does to the run's row. */
    moveTo: (next: DesktopRunnerRunView["state"]) => {
      state = next;
      runBell.ring(RUNNER_RUN_ID);
    },
  };
};

type TurnOptions = {
  clock: ReturnType<typeof createDeadlineClock>;
  runsOn: ChatRunTarget["kind"];
  source: (abortSignal: AbortSignal) => AsyncIterable<PublicStreamChunk>;
};

/** One turn's run over `source`, through the pipeline that stores a turn. */
const startTurn = ({ clock, runsOn, source }: TurnOptions) => {
  const ownership = new ChatTurnOwnership();
  const run = new ChatTurnRun({
    bound: chatTurnRunBoundOf(runsOn),
    connectors: undefined,
    createDeadlineSignal: clock.createDeadlineSignal,
    heartbeat: { intervalMs: HOUR_MS, renewEvery: 1000 },
    mode: "raw",
    ownership,
    owner: {
      indexThread: async () => {},
      execution: { id: TURN_ID, executionId: Bun.randomUUIDv7() },
      owningAssistantMessage: undefined,
      recordAuditEvent: async () => {},
      safeDb: createScopedDbMock({}).safeDb,
      threadId: THREAD_ID,
      userId: toSafeId<"user">("user_bound"),
      workspaceId: null,
    },
  });
  const { processor, message } = createStreamMessageCapture({
    initialMessages: [],
    capture: toChatMessage,
  });
  const outcomes: ChatTurnOutcome[] = [];
  const emitted: PublicStreamChunk[] = [];
  let changed = Promise.withResolvers<undefined>();
  const output = processServerChatStream({
    abortSignal: run.control.providerAbortController.signal,
    runSignal: run.control.abortController.signal,
    deadlineSignal: run.control.deadlineSignal,
    getResponseMessage: message,
    initialMessages: [],
    mapMessageId: createChatMessageIdMapper(() =>
      toSafeId<"chatMessage">("11111111-1111-4111-8111-111111111111"),
    ),
    processor,
    source: source(run.control.abortController.signal),
    onFinish: async ({ outcome }) => {
      outcomes.push(outcome);
      await run.settle(async () => ({ type: "stored", outcome }));
    },
  });
  const observed = (async function* (): AsyncIterable<PublicStreamChunk> {
    for await (const chunk of output) {
      emitted.push(chunk);
      changed.resolve(undefined);
      changed = Promise.withResolvers<undefined>();
      yield chunk;
    }
  })();
  const delivered = run
    .produce(
      observed,
      memoryStream({ runId: Bun.randomUUIDv7() }),
      HELD_TEST_STREAM_BINDING,
    )
    .text();
  return {
    run,
    ownership,
    outcomes,
    /** Resolves once the turn emitted a chunk `matches` accepts. */
    emits: async (matches: (chunk: PublicStreamChunk) => boolean) => {
      await withTimeout(
        async () => {
          while (!emitted.some(matches)) {
            await changed.promise;
          }
        },
        { label: "turn output", timeoutMs: HAPPY_PATH_TIMEOUT_MS },
      );
    },
    /** The run's end and what its response delivered. */
    ended: async () =>
      await withTimeout(
        async () => ({ end: await run.settled, body: await delivered }),
        { label: "turn settlement", timeoutMs: HAPPY_PATH_TIMEOUT_MS },
      ),
  };
};

const localSource =
  (
    computer: ReturnType<typeof createComputer>,
    resume?: readonly RunAgentResumeItem[],
  ) =>
  (abortSignal: AbortSignal) =>
    createLocalChatRun(
      computer.context,
      resume === undefined
        ? { type: "start", destination: DESTINATION }
        : { type: "resume", harness: DESTINATION.harness },
    ).stream({
      chatRunId: "chat-run-bound",
      chatTurnId: TURN_ID,
      messages: [],
      instructions: "You are stella.",
      resume,
      abortSignal,
    });

const hasText = (text: string) => (chunk: PublicStreamChunk) =>
  chunk.type === EventType.TEXT_MESSAGE_CONTENT && chunk.delta.includes(text);

/** The turn told the chat where its computer stands. */
const computerIs = (status: string) => (chunk: PublicStreamChunk) =>
  chunk.type === EventType.CUSTOM &&
  chunk.name === CHAT_LOCAL_RUN_COMPUTER_EVENT &&
  isRecord(chunk.value) &&
  chunk.value["status"] === status;

describe("a turn on the member's computer", () => {
  test("keeps working for hours past the provider deadline", async () => {
    const clock = createDeadlineClock();
    const computer = createComputer();
    const chunks = await harnessChunks([
      {
        type: "session.started",
        sessionId: harnessSessionId("session-long-work"),
        continuation: { type: "fresh" },
      },
      { type: "text.delta", messageId: "answer", delta: "Reading the file. " },
      { type: "text.delta", messageId: "answer", delta: "The build passes." },
      {
        type: "text.completed",
        messageId: "answer",
        text: "Reading the file. The build passes.",
      },
      { type: "turn.completed", usage: null },
    ]);
    const firstText = chunks.findIndex(hasText("Reading the file."));
    expect(firstText).toBeGreaterThan(-1);
    const turn = startTurn({
      clock,
      runsOn: CHAT_RUN_TARGET_KIND.local,
      source: localSource(computer),
    });
    computer.events(chunks.slice(0, firstText + 1));
    await turn.emits(hasText("Reading the file."));

    clock.advance(CHAT_METERED_PROVIDER_TIMEOUT_MS);
    clock.advance(3 * HOUR_MS);

    expect(turn.run.control.abortController.signal.aborted).toBe(false);
    expect(turn.outcomes).toEqual([]);
    expect(computer.queued.interrupts).toBe(0);
    computer.events(chunks.slice(firstText + 1));
    computer.finish();
    const { end, body } = await turn.ended();
    expect(end).toBe("stored");
    expect(turn.outcomes).toEqual([{ type: "completed" }]);
    expect(body).toContain("The build passes.");
    expect(computer.queued.interrupts).toBe(0);
  });

  test("waits on the member for hours, then works on for hours once answered", async () => {
    const clock = createDeadlineClock();
    const computer = createComputer();
    const toolCall = {
      id: "item_7",
      name: "command_execution",
      input: { command: "bun test" },
    };
    const chunks = await harnessChunks([
      {
        type: "session.started",
        sessionId: harnessSessionId("session-long-wait"),
        continuation: { type: "fresh" },
      },
      {
        type: "approval.requested",
        request: {
          requestId: REQUEST_ID,
          kind: "command",
          toolCall,
          reason: "Run the test suite",
          options: [
            { id: "accept", decision: "approve" },
            { id: "decline", decision: "deny" },
          ],
        },
      },
      { type: "interaction.resolved", requestId: REQUEST_ID },
      {
        type: "tool.completed",
        toolCall,
        result: { content: "12 pass", status: "succeeded" },
      },
      { type: "text.delta", messageId: "answer", delta: "All tests pass." },
      { type: "text.completed", messageId: "answer", text: "All tests pass." },
      { type: "turn.completed", usage: null },
    ]);
    const pauseAt = chunks.findIndex(isPause) + 1;
    expect(pauseAt).toBeGreaterThan(0);
    const asking = startTurn({
      clock,
      runsOn: CHAT_RUN_TARGET_KIND.local,
      source: localSource(computer),
    });
    computer.approvalRequest();
    computer.events(chunks.slice(0, pauseAt));

    // The turn that asked is over once it waits: the wait holds no run.
    expect((await asking.ended()).end).toBe("stored");
    expect(asking.outcomes).toMatchObject([{ type: "awaiting-user" }]);
    expect(
      asking.ownership.run(asking.run.execution.executionId),
    ).toBeUndefined();
    expect(computer.chatReadSeq()).toBe(pauseAt + 1);

    clock.advance(CHAT_METERED_PROVIDER_TIMEOUT_MS);
    clock.advance(8 * HOUR_MS);
    expect(computer.queued.interrupts).toBe(0);

    const answered = startTurn({
      clock,
      runsOn: CHAT_RUN_TARGET_KIND.local,
      source: localSource(computer, [
        { interruptId: REQUEST_ID, status: "resolved", payload: true },
      ]),
    });
    const resultAt = chunks.findIndex(
      (chunk) => chunk.type === EventType.TOOL_CALL_RESULT,
    );
    expect(resultAt).toBeGreaterThanOrEqual(pauseAt);
    computer.events(chunks.slice(pauseAt, resultAt + 1));
    await answered.emits((chunk) => chunk.type === EventType.TOOL_CALL_RESULT);
    expect(computer.queued.approvals).toBe(1);

    clock.advance(CHAT_METERED_PROVIDER_TIMEOUT_MS);
    clock.advance(3 * HOUR_MS);

    expect(answered.run.control.abortController.signal.aborted).toBe(false);
    expect(answered.outcomes).toEqual([]);
    computer.events(chunks.slice(resultAt + 1));
    computer.finish();
    const { end, body } = await answered.ended();
    expect(end).toBe("stored");
    expect(answered.outcomes).toEqual([{ type: "completed" }]);
    expect(body).toContain("All tests pass.");
    expect(computer.queued.interrupts).toBe(0);
    // No deadline was armed for any of the three runs' turns.
    expect(clock.armed()).toBe(0);
  });

  test("fails with the computer's reason once the gateway gave its silent computer up", async () => {
    const clock = createDeadlineClock();
    const computer = createComputer();
    const turn = startTurn({
      clock,
      runsOn: CHAT_RUN_TARGET_KIND.local,
      source: localSource(computer),
    });
    // The run's lease lapsed: its computer stopped answering.
    computer.moveTo("waiting_for_computer");
    await turn.emits(computerIs("waiting"));

    clock.advance(CHAT_METERED_PROVIDER_TIMEOUT_MS);
    clock.advance(3 * HOUR_MS);

    // Away is not over: the computer may come back to the run.
    expect(turn.run.control.abortController.signal.aborted).toBe(false);
    expect(turn.outcomes).toEqual([]);
    // The abandon window passed without it.
    computer.moveTo("lost");
    const { end, body } = await turn.ended();
    expect(end).toBe("stored");
    expect(turn.outcomes).toMatchObject([
      { type: "failed", error: "local_runner_unavailable" },
    ]);
    expect(body).toContain('"code":"local_runner_unavailable"');
    // The gateway ended the run; nothing is left to interrupt.
    expect(computer.queued.interrupts).toBe(0);
  });

  test("ends at the member's stop and interrupts the computer once", async () => {
    const clock = createDeadlineClock();
    const computer = createComputer();
    const turn = startTurn({
      clock,
      runsOn: CHAT_RUN_TARGET_KIND.local,
      source: localSource(computer),
    });
    await turn.emits(computerIs("delivering"));
    clock.advance(3 * HOUR_MS);

    const stopped = turn.run.stop();

    expect((await turn.ended()).end).toBe("stored");
    expect(await stopped).toBe("stored");
    expect(turn.outcomes).toMatchObject([{ type: "cancelled" }]);
    expect(computer.queued.interrupts).toBe(1);
  });
});

describe("a turn stella's own model answers", () => {
  test("is cut at the provider deadline, not before", async () => {
    const clock = createDeadlineClock();
    const providerMayFinish = Promise.withResolvers<undefined>();
    const turn = startTurn({
      clock,
      runsOn: CHAT_RUN_TARGET_KIND.cloud,
      source: () =>
        (async function* (): AsyncIterable<PublicStreamChunk> {
          yield {
            type: EventType.TEXT_MESSAGE_START,
            messageId: "answer",
            role: "assistant",
          };
          yield {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "answer",
            delta: "Partial answer",
          };
          // A provider that stopped answering and ignores the abort.
          await providerMayFinish.promise;
        })(),
    });
    try {
      await turn.emits(hasText("Partial answer"));
      expect(clock.armed()).toBe(1);

      clock.advance(CHAT_METERED_PROVIDER_TIMEOUT_MS - 1);
      expect(turn.run.control.abortController.signal.aborted).toBe(false);
      expect(turn.outcomes).toEqual([]);

      clock.advance(1);
      const { end, body } = await turn.ended();
      expect(end).toBe("stored");
      expect(turn.outcomes).toEqual([
        { type: "interrupted", reason: "timeout" },
      ]);
      expect(body).toContain("Partial answer");
    } finally {
      providerMayFinish.resolve(undefined);
    }
  });
});
