import { EventType, memoryStream } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { harnessSessionId } from "@stll/agent-engine";
import {
  CHAT_LOCAL_RUN_COMPUTER_EVENT,
  CHAT_RUN_TARGET_KIND,
  type ChatRunTarget,
} from "@stll/api-contract/chat-run-target";

import { toSafeId } from "@/api/lib/branded-types";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import { isRecord } from "@/api/lib/type-guards";
import { withTimeout } from "@/api/lib/with-timeout";
import {
  createComputer,
  harnessChunks,
  isPause,
  localSource,
  REQUEST_ID,
  THREAD_ID,
  TURN_ID,
} from "@/api/tests/helpers/fake-local-computer";
import { HELD_TEST_STREAM_BINDING } from "@/api/tests/helpers/sse-stream-binding";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";
import { HAPPY_PATH_TIMEOUT_MS } from "@/api/tests/test-timeouts";

import { CHAT_METERED_PROVIDER_TIMEOUT_MS } from "./chat-turn-persistence";
import {
  ChatTurnOwnership,
  ChatTurnRun,
  chatTurnRunBoundOf,
} from "./chat-turn-run";
import { processServerChatStream, toChatMessage } from "./stream-chat";
import { createChatMessageIdMapper } from "./stream-message-identity";
import type { ChatTurnOutcome } from "./types";

const HOUR_MS = 60 * 60 * 1000;

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
      { type: "turn.completed", usage: null, boundary: null },
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
      { type: "turn.completed", usage: null, boundary: null },
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
