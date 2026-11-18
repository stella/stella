import { EventType, memoryStream } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import {
  CHAT_RUN_TARGET_KIND,
  type ChatRunTarget,
} from "@stll/api-contract/chat-run-target";

import { toSafeId } from "@/api/lib/branded-types";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import { withTimeout } from "@/api/lib/with-timeout";
import {
  createComputer,
  harnessChunks,
  localSource,
  THREAD_ID,
  TURN_ID,
} from "@/api/tests/helpers/fake-local-computer";
import { HELD_TEST_STREAM_BINDING } from "@/api/tests/helpers/sse-stream-binding";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";
import { HAPPY_PATH_TIMEOUT_MS } from "@/api/tests/test-timeouts";

import {
  CHAT_TURN_HAND_OVER_BUDGET_MS,
  ChatTurnOwnership,
  type ChatTurnRelinquishment,
  ChatTurnRun,
  chatTurnRunBoundOf,
  type ChatTurnStoredSettlement,
} from "./chat-turn-run";
import { processServerChatStream, toChatMessage } from "./stream-chat";
import { createChatMessageIdMapper } from "./stream-message-identity";
import type { ChatTurnOutcome, PersistableChatMessage } from "./types";

// A stopping process gives up its turns. With hand-over on, a turn read from
// a computer is released to another task within its budget and the computer
// is never interrupted; otherwise, and for a turn the process's own provider
// request answers, the turn ends as `owner-lost` as before.

const HOUR_MS = 60 * 60 * 1000;
const HAND_OVER = {
  type: "hand-over",
  budgetMs: CHAT_TURN_HAND_OVER_BUDGET_MS,
} as const satisfies ChatTurnRelinquishment;

type TurnOptions = {
  runsOn: ChatRunTarget["kind"];
  /** What storing a release does; stored at once by default. */
  storeRelease?: () => Promise<ChatTurnStoredSettlement>;
};

/** One local turn's run over a fake computer, through the turn pipeline. */
const startTurn = ({
  runsOn,
  storeRelease = async () => await Promise.resolve({ type: "handed-over" }),
}: TurnOptions) => {
  const computer = createComputer();
  const ownership = new ChatTurnOwnership();
  const run = new ChatTurnRun({
    bound: chatTurnRunBoundOf(runsOn),
    connectors: undefined,
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
  const released: PersistableChatMessage[] = [];
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
    source: localSource(computer)(
      run.control.abortController.signal,
      run.control.handOverSignal,
    ),
    onFinish: async ({ outcome }) => {
      outcomes.push(outcome);
      await run.settle(async () => ({ type: "stored", outcome }));
    },
    onRelease: async (answer) => {
      released.push(answer);
      await run.settle(storeRelease);
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
    computer,
    delivered,
    emitted,
    ownership,
    outcomes,
    released,
    run,
    /** Resolves once the turn emitted text containing `text`. */
    shows: async (text: string) => {
      await withTimeout(
        async () => {
          while (
            !emitted.some(
              (chunk) =>
                chunk.type === EventType.TEXT_MESSAGE_CONTENT &&
                chunk.delta.includes(text),
            )
          ) {
            await changed.promise;
          }
        },
        { label: "turn output", timeoutMs: HAPPY_PATH_TIMEOUT_MS },
      );
    },
  };
};

const withinHappyPath = async <T>(work: Promise<T>): Promise<T> =>
  await withTimeout(async () => await work, {
    label: "relinquish",
    timeoutMs: HAPPY_PATH_TIMEOUT_MS,
  });

const readingAnswer = async () =>
  await harnessChunks([
    { type: "text.delta", messageId: "answer", delta: "Reading the files." },
  ]);

describe("a stopping process with hand-over on", () => {
  test("releases a local turn mid-answer without interrupting the computer", async () => {
    const turn = startTurn({ runsOn: CHAT_RUN_TARGET_KIND.local });
    const events = await readingAnswer();
    turn.computer.events(events);
    await turn.shows("Reading the files.");

    expect(await withinHappyPath(turn.ownership.relinquish(HAND_OVER))).toBe(
      "stored",
    );

    expect(turn.outcomes).toEqual([]);
    expect(turn.released).toHaveLength(1);
    expect(turn.released.at(0)?.parts).toEqual([
      { type: "text", content: "Reading the files." },
    ]);
    // The run start went out before the release; no end went out at all.
    expect(turn.emitted.at(0)).toMatchObject({ type: EventType.RUN_STARTED });
    expect(
      turn.emitted.some(
        (chunk) =>
          chunk.type === EventType.RUN_FINISHED ||
          chunk.type === EventType.RUN_ERROR,
      ),
    ).toBe(false);
    // Recorded where the read stopped: past the text it showed, and no
    // further than the computer stored.
    const shown = events.findIndex(
      (chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT,
    );
    expect(turn.computer.chatReadSeq()).toBeGreaterThan(shown);
    expect(turn.computer.chatReadSeq()).toBeLessThanOrEqual(events.length);
    expect(turn.computer.queued.interrupts).toBe(0);
  });

  test("leaves a turn whose release misses the budget running, uninterrupted", async () => {
    const stuck = Promise.withResolvers<ChatTurnStoredSettlement>();
    const turn = startTurn({
      runsOn: CHAT_RUN_TARGET_KIND.local,
      // A store that does not answer within the budget.
      storeRelease: async () => await stuck.promise,
    });
    turn.computer.events(await readingAnswer());
    await turn.shows("Reading the files.");

    expect(
      await withinHappyPath(
        turn.ownership.relinquish({ type: "hand-over", budgetMs: 20 }),
      ),
    ).toBe("unstored");

    // Nothing settled the turn: it stays running for its lease and the
    // reaper, today's path for a run that could not store its outcome.
    expect(turn.outcomes).toEqual([]);
    expect(turn.computer.queued.interrupts).toBe(0);
    stuck.resolve({ type: "left-running" });
    expect(await withinHappyPath(turn.run.settled)).toBe("unstored");
  });

  test("ends a turn its own provider request answers as owner-lost", async () => {
    const turn = startTurn({ runsOn: CHAT_RUN_TARGET_KIND.cloud });
    turn.computer.events(await readingAnswer());
    await turn.shows("Reading the files.");

    expect(await withinHappyPath(turn.ownership.relinquish(HAND_OVER))).toBe(
      "stored",
    );

    expect(turn.released).toEqual([]);
    expect(turn.outcomes).toEqual([
      { type: "interrupted", reason: "owner-lost" },
    ]);
  });
});

describe("a stopping process with hand-over off", () => {
  test("ends a local turn as owner-lost, as before, and releases nothing", async () => {
    const turn = startTurn({ runsOn: CHAT_RUN_TARGET_KIND.local });
    turn.computer.events(await readingAnswer());
    await turn.shows("Reading the files.");

    expect(
      await withinHappyPath(turn.ownership.relinquish({ type: "end" })),
    ).toBe("stored");

    expect(turn.released).toEqual([]);
    expect(turn.outcomes).toEqual([
      { type: "interrupted", reason: "owner-lost" },
    ]);
    // The ended turn's run is cancelled from its row by the gateway's sweep
    // (`cancelRunsOfEndedChatTurns`), not by the reader.
    expect(turn.computer.queued.interrupts).toBe(0);
  });
});
