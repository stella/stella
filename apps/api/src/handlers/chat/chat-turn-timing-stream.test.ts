import {
  EventType,
  memoryStream,
  toServerSentEventsResponse,
} from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";

import {
  createChatTurnTimingObserver,
  getChatTurnDurationMs,
} from "@stll/api-contract/chat-turn-duration";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  createChatTurnTimingDurability,
  withChatTurnTiming,
} from "@/api/handlers/chat/chat-turn-timing-stream";
import { observeChatOutputStages } from "@/api/handlers/chat/stream-chat";
import type { ChatTurnTiming } from "@/api/handlers/chat/types";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import { readPresent, readUnavailable } from "@/api/lib/errors/read-outcome";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import * as failureObservation from "@/api/lib/observability/observe-failure";
import { buildWireSnapshot } from "@/api/tests/helpers/chat-fixtures";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

const running = {
  status: "running",
  durationMs: 4000,
  startedAt: "2026-01-01T00:00:00.000Z",
  observedAt: "2026-01-01T00:00:00.000Z",
  elapsedMs: 0,
} as const satisfies ChatTurnTiming;
const finished = {
  status: "finished",
  durationMs: 9000,
} as const satisfies ChatTurnTiming;
const runStart = {
  type: EventType.RUN_STARTED,
  runId: "run",
  threadId: "thread",
  timestamp: 0,
} as const satisfies StreamChunk;
const runEnd = {
  type: EventType.RUN_FINISHED,
  runId: "run",
  threadId: "thread",
  timestamp: 9000,
} as const satisfies StreamChunk;
const chunksOf = async function* (chunks: StreamChunk[]) {
  yield* chunks;
};
const starts = [
  {
    type: EventType.TEXT_MESSAGE_START,
    messageId: "answer",
    role: "assistant",
    timestamp: 0,
  },
  {
    type: EventType.REASONING_MESSAGE_START,
    messageId: "answer",
    role: "reasoning",
    timestamp: 0,
  },
  {
    type: EventType.TOOL_CALL_START,
    parentMessageId: "answer",
    toolCallId: "call",
    toolCallName: "synthetic",
    timestamp: 0,
  },
] as const satisfies readonly StreamChunk[];

test("records a cancelled stream when its consumer returns after one chunk", async () => {
  let clock = 10;
  const records: { stage: string; outcome: string }[] = [];
  const iterator = observeChatOutputStages({
    source: chunksOf([starts[0], runEnd]),
    startedAt: 0,
    getSettlementOutcome: () => undefined,
    now: () => clock,
    emitStage: ({ stage, outcome }) => {
      records.push({ stage, outcome });
    },
  })[Symbol.asyncIterator]();

  expect((await iterator.next()).value).toEqual(starts[0]);
  clock = 25;
  await iterator.return();

  expect(records).toEqual([{ stage: "stream_finish", outcome: "cancelled" }]);
});

test("records the first answer-bearing chunk once, at its own time", async () => {
  let clock = 5;
  const answerAt = async function* () {
    yield starts[0];
    clock = 12;
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "answer",
      delta: "Hello",
      timestamp: 12,
    } satisfies StreamChunk;
    clock = 40;
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "answer",
      delta: " world",
      timestamp: 40,
    } satisfies StreamChunk;
  };
  const records: { stage: string; durationMs: number }[] = [];
  await Array.fromAsync(
    observeChatOutputStages({
      source: answerAt(),
      startedAt: 5,
      getSettlementOutcome: () => "completed",
      now: () => clock,
      emitStage: ({ stage, durationMs }) => {
        records.push({ stage, durationMs });
      },
    }),
  );

  expect(records).toEqual([
    { stage: "provider_first_token", durationMs: 7 },
    { stage: "stream_finish", durationMs: 35 },
  ]);
});

test("records a successfully settled stream as completed", async () => {
  const records: { stage: string; outcome: string }[] = [];
  await Array.fromAsync(
    observeChatOutputStages({
      source: chunksOf([starts[0], runEnd]),
      startedAt: 0,
      getSettlementOutcome: () => "completed",
      now: () => 20,
      emitStage: ({ stage, outcome }) => {
        records.push({ stage, outcome });
      },
    }),
  );
  expect(records).toEqual([{ stage: "stream_finish", outcome: "completed" }]);
});

test("records a normally exhausted error settlement as failed", async () => {
  const runError = {
    type: EventType.RUN_ERROR,
    message: "The provider stream ended with an error.",
    code: "incomplete-stream",
  } as const satisfies StreamChunk;
  const records: { stage: string; outcome: string }[] = [];
  await Array.fromAsync(
    observeChatOutputStages({
      source: chunksOf([starts[0], runError]),
      startedAt: 0,
      getSettlementOutcome: () => "failed",
      now: () => 20,
      emitStage: ({ stage, outcome }) => {
        records.push({ stage, outcome });
      },
    }),
  );
  expect(records).toEqual([{ stage: "stream_finish", outcome: "failed" }]);
});

test("records a failed stream once and preserves the source error", async () => {
  const failure = new HandlerError({ status: 500, message: "stream failed" });
  const source = async function* () {
    yield starts[0];
    throw failure;
  };
  const records: { stage: string; outcome: string }[] = [];
  const iterator = observeChatOutputStages({
    source: source(),
    startedAt: 0,
    getSettlementOutcome: () => undefined,
    now: () => 30,
    emitStage: ({ stage, outcome }) => {
      records.push({ stage, outcome });
    },
  })[Symbol.asyncIterator]();
  await iterator.next();

  expect(await rejectionOf(iterator.next())).toBe(failure);
  expect(records).toEqual([{ stage: "stream_finish", outcome: "failed" }]);
});

describe("active timing through the real SDK message processor", () => {
  for (const start of starts) {
    test(`preserves live and settled metadata for ${start.type}`, async () => {
      const capture = createStreamMessageCapture({
        initialMessages: [],
        capture: (message) => message,
      });
      let reads = 0;
      let sawRunning = false;
      for await (const chunk of withChatTurnTiming({
        source: chunksOf([
          runStart,
          start,
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "answer",
            delta: "Answer",
            timestamp: 1000,
          },
          runEnd,
        ]),
        getPhase: () => "settled",
        readTiming: async () => readPresent(++reads === 1 ? running : finished),
      })) {
        const encodedEvent = JSON.stringify(chunk);
        capture.processor.processChunk(JSON.parse(encodedEvent));
        if (
          capture.processor
            .getMessages()
            .some(
              ({ metadata }) => metadata?.["turnTiming"]?.status === "running",
            )
        ) {
          sawRunning = true;
        }
      }
      expect(sawRunning).toBe(true);
      expect(capture.message()?.metadata?.["turnTiming"]).toEqual(finished);
      expect(
        capture.message()?.parts.filter((part) => part.type === "text"),
      ).toEqual([{ type: "text", content: "Answer" }]);
      expect(reads).toBe(2);
    });
  }
  test("unknown terminal time clears a live anchor across the wire", async () => {
    const capture = createStreamMessageCapture({
      initialMessages: [],
      capture: (message) => message,
    });
    let reads = 0;
    for await (const chunk of withChatTurnTiming({
      source: chunksOf([runStart, starts[0], runEnd]),
      getPhase: () => "settled",
      readTiming: async () => readPresent(++reads === 1 ? running : null),
    })) {
      const encodedEvent = JSON.stringify(chunk);
      capture.processor.processChunk(JSON.parse(encodedEvent));
    }
    expect(capture.message()?.metadata?.["turnTiming"]).toBeNull();
  });
  test("child runs cannot own or settle the parent duration", async () => {
    let reads = 0;
    const childStart = {
      ...starts[0],
      messageId: "child",
      subagentRunId: "child-run",
    };
    const childEnd = { ...runEnd, subagentRunId: "child-run" };
    const events = [];
    for await (const chunk of withChatTurnTiming({
      source: chunksOf([runStart, childStart, childEnd, starts[0], runEnd]),
      getPhase: () => "settled",
      readTiming: async () => readPresent(++reads === 1 ? running : finished),
    })) {
      events.push(chunk);
    }
    expect(events).toContainEqual(childStart);
    expect(events).toContainEqual(childEnd);
    expect(
      events
        .filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_END)
        .map((chunk) => chunk.messageId),
    ).toEqual(["answer"]);
    expect(reads).toBe(2);
  });
});

describe("active timing at iteration and snapshot boundaries", () => {
  test("untracked snapshots leave timing unread", async () => {
    const snapshot = buildWireSnapshot([
      {
        id: "unrelated",
        role: "assistant",
        parts: [{ type: "text", content: "Previous answer" }],
      },
    ]);
    let reads = 0;
    const events = [];
    for await (const chunk of withChatTurnTiming({
      source: chunksOf([runStart, snapshot]),
      getPhase: () => "running",
      readTiming: async () => {
        reads++;
        return readPresent(running);
      },
    })) {
      events.push(chunk);
    }
    expect(events).toEqual([runStart, snapshot]);
    expect(reads).toBe(0);
  });

  for (const start of starts) {
    for (const delayMs of [3000, 18_000]) {
      test(`refreshes server timing after ${delayMs}ms before ${start.type} and a later snapshot`, async () => {
        const capture = createStreamMessageCapture({
          initialMessages: [],
          capture: (message) => message,
        });
        let serverNowMs = 0;
        let phase: "running" | "settled" = "running";
        let reads = 0;
        let liveAttachments = 0;
        const endings = [];
        const observeClientTiming = createChatTurnTimingObserver();
        const settled = {
          status: "finished",
          durationMs: running.durationMs + delayMs * 3,
        } as const satisfies ChatTurnTiming;
        for await (const chunk of withChatTurnTiming({
          source: (async function* () {
            yield runStart;
            serverNowMs += delayMs;
            yield start;
            serverNowMs += delayMs;
            yield buildWireSnapshot([
              {
                id: "answer",
                role: "assistant",
                parts: [{ type: "text", content: "Partial" }],
              },
            ]);
            serverNowMs += delayMs;
            phase = "settled";
            yield runEnd;
            yield runEnd;
          })(),
          getPhase: () => phase,
          readTiming: async () => {
            reads++;
            return readPresent(
              phase === "settled"
                ? settled
                : {
                    ...running,
                    elapsedMs: serverNowMs,
                    observedAt: new Date(
                      Date.parse(running.startedAt) + serverNowMs,
                    ).toISOString(),
                  },
            );
          },
        })) {
          capture.processor.processChunk(structuredClone(chunk));
          if (
            chunk.type === EventType.TEXT_MESSAGE_START ||
            chunk.type === EventType.MESSAGES_SNAPSHOT
          ) {
            liveAttachments++;
            const deliveredTiming = capture.processor
              .getMessages()
              .find(({ id }) => id === "answer")?.metadata?.["turnTiming"];
            expect(deliveredTiming).toEqual({
              ...running,
              elapsedMs: serverNowMs,
              observedAt: new Date(
                Date.parse(running.startedAt) + serverNowMs,
              ).toISOString(),
            });
            const clientReceiptMs = 100 + liveAttachments * 1000;
            observeClientTiming(
              [
                {
                  id: "answer",
                  metadata: { turnTiming: deliveredTiming },
                },
              ],
              clientReceiptMs,
            );
            expect(
              getChatTurnDurationMs(deliveredTiming, clientReceiptMs),
            ).toBe(running.durationMs + serverNowMs);
            expect(
              getChatTurnDurationMs(deliveredTiming, clientReceiptMs + 1000),
            ).toBe(running.durationMs + serverNowMs + 1000);
          }
          if (chunk.type === EventType.TEXT_MESSAGE_END) {
            endings.push(chunk.metadata?.["turnTiming"]);
          }
        }
        expect(liveAttachments).toBe(2);
        expect(endings).toEqual([settled]);
        const deliveredMessage = capture.processor
          .getMessages()
          .find(({ id }) => id === "answer");
        expect(deliveredMessage?.metadata?.["turnTiming"]).toEqual(settled);
        expect(deliveredMessage?.parts).toEqual([
          { type: "text", content: "Partial" },
        ]);
        expect(reads).toBe(3);
      });
    }
  }

  test("keeps timing running until the final model iteration settles", async () => {
    const capture = createStreamMessageCapture({
      initialMessages: [],
      capture: (message) => message,
    });
    let reads = 0;
    let phase: "running" | "settled" = "running";
    for await (const chunk of withChatTurnTiming({
      source: (async function* () {
        for await (const sourceChunk of chunksOf([
          runStart,
          starts[0],
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "answer",
            delta: "First ",
            timestamp: 1000,
          },
          { ...runEnd, timestamp: 2000 },
          { ...runStart, timestamp: 3000 },
          starts[0],
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "answer",
            delta: "second",
            timestamp: 8000,
          },
          runEnd,
        ])) {
          if (
            sourceChunk.type === EventType.RUN_STARTED &&
            sourceChunk.timestamp === 3000
          ) {
            expect(reads).toBe(1);
          }
          if (sourceChunk === runEnd) {
            phase = "settled";
          }
          yield sourceChunk;
        }
      })(),
      getPhase: () => phase,
      readTiming: async () => readPresent(++reads <= 2 ? running : finished),
    })) {
      const encodedEvent = JSON.stringify(chunk);
      capture.processor.processChunk(JSON.parse(encodedEvent));
    }
    expect(
      capture.processor.getMessages().find(({ id }) => id === "answer")
        ?.metadata?.["turnTiming"],
    ).toEqual(finished);
    expect(reads).toBe(3);
  });

  test("tool-only snapshots preserve live metadata and settle without answer text", async () => {
    const capture = createStreamMessageCapture({
      initialMessages: [],
      capture: (message) => message,
    });
    let reads = 0;
    let snapshotTiming: unknown;
    for await (const chunk of withChatTurnTiming({
      source: chunksOf([
        runStart,
        starts[2],
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "call",
          delta: "{}",
          timestamp: 1000,
        },
        { type: EventType.TOOL_CALL_END, toolCallId: "call", timestamp: 2000 },
        {
          ...buildWireSnapshot([
            {
              id: "answer",
              role: "assistant",
              parts: [
                {
                  type: "tool-call",
                  id: "call",
                  name: "synthetic",
                  arguments: "{}",
                  state: "input-complete",
                },
              ],
            },
          ]),
          timestamp: 3000,
        },
        runEnd,
      ]),
      getPhase: () => "settled",
      readTiming: async () => readPresent(++reads <= 2 ? running : finished),
    })) {
      const encodedEvent = JSON.stringify(chunk);
      capture.processor.processChunk(JSON.parse(encodedEvent));
      if (chunk.type === EventType.MESSAGES_SNAPSHOT) {
        snapshotTiming = capture.processor
          .getMessages()
          .find(({ id }) => id === "answer")?.metadata?.["turnTiming"];
      }
    }
    expect(snapshotTiming).toEqual(running);
    expect(reads).toBe(3);
    expect(
      capture.processor.getMessages().find(({ id }) => id === "answer")
        ?.metadata?.["turnTiming"],
    ).toEqual(finished);
    expect(
      capture.processor
        .getMessages()
        .find(({ id }) => id === "answer")
        ?.parts.some((part) => part.type === "tool-call"),
    ).toBe(true);
  });

  test("failed turns retain exact settled duration after SDK error processing", async () => {
    const capture = createStreamMessageCapture({
      initialMessages: [],
      capture: (message) => message,
    });
    let reads = 0;
    for await (const chunk of withChatTurnTiming({
      source: chunksOf([
        runStart,
        starts[0],
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "answer",
          delta: "Partial",
          timestamp: 1000,
        },
        {
          type: EventType.RUN_ERROR,
          runId: "run",
          threadId: "thread",
          message: "Synthetic failure",
          code: "provider-error",
          timestamp: 9000,
        },
      ]),
      getPhase: () => "settled",
      readTiming: async () => readPresent(++reads === 1 ? running : finished),
    })) {
      const encodedEvent = JSON.stringify(chunk);
      capture.processor.processChunk(JSON.parse(encodedEvent));
    }
    expect(
      capture.processor.getMessages().find(({ id }) => id === "answer")
        ?.metadata?.["turnTiming"],
    ).toEqual(finished);
    expect(reads).toBe(2);
  });
});

test("duplicate terminal receipts emit settled timing exactly once", async () => {
  let reads = 0;
  const endings = [];
  for await (const chunk of withChatTurnTiming({
    source: chunksOf([runStart, starts[0], runEnd, runEnd]),
    getPhase: () => "settled",
    readTiming: async () => readPresent(++reads === 1 ? running : finished),
  })) {
    if (chunk.type === EventType.TEXT_MESSAGE_END) {
      endings.push(chunk.metadata?.["turnTiming"]);
    }
  }
  expect(endings).toEqual([finished]);
  expect(reads).toBe(2);
});

test("a cut-short source settles after draining without a terminal event", async () => {
  const capture = createStreamMessageCapture({
    initialMessages: [],
    capture: (message) => message,
  });
  const sourceChunks = [
    runStart,
    starts[0],
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "answer",
      delta: "Partial",
      timestamp: 1000,
    },
  ] satisfies StreamChunk[];
  let phase: "running" | "settled" = "running";
  let reads = 0;
  const endings = [];
  for await (const chunk of withChatTurnTiming({
    source: (async function* () {
      yield* sourceChunks;
      // The server settles cancellation/deadline after the SDK drains.
      phase = "settled";
    })(),
    getPhase: () => phase,
    readTiming: async () => readPresent(++reads === 1 ? running : finished),
  })) {
    capture.processor.processChunk(structuredClone(chunk));
    if (chunk.type === EventType.TEXT_MESSAGE_END) {
      endings.push(chunk.metadata?.["turnTiming"]);
    }
  }
  capture.processor.finalizeStream();
  expect(endings).toEqual([finished]);
  expect(capture.message()?.metadata?.["turnTiming"]).toEqual(finished);
  expect(capture.message()?.parts).toEqual([
    { type: "text", content: "Partial" },
  ]);
  expect(reads).toBe(2);
});

test("a failed final timing read clears the live anchor without losing the answer", async () => {
  const capture = createStreamMessageCapture({
    initialMessages: [],
    capture: (message) => message,
  });
  let reads = 0;
  for await (const chunk of withChatTurnTiming({
    source: chunksOf([
      runStart,
      starts[0],
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "answer",
        delta: "Answer",
        timestamp: 1000,
      },
      runEnd,
    ]),
    getPhase: () => "settled",
    readTiming: async () =>
      ++reads === 1
        ? readPresent(running)
        : readUnavailable({ kind: "status", status: 503 }),
  })) {
    capture.processor.processChunk(chunk);
  }
  expect(capture.message()?.metadata?.["turnTiming"]).toBeNull();
  expect(capture.message()?.parts).toEqual([
    { type: "text", content: "Answer" },
  ]);
});

for (const batchSize of [1, 2, 32]) {
  test(`durable timing reaches the live SDK and replay at batch size ${batchSize}`, async () => {
    const stored: StreamChunk[] = [];
    const capture = createStreamMessageCapture({
      initialMessages: [],
      capture: (message) => message,
    });
    const response = toServerSentEventsResponse(
      withChatTurnTiming({
        source: chunksOf([
          runStart,
          starts[0],
          ...Array.from(
            { length: 30 },
            () =>
              ({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: "answer",
                delta: "x",
              }) as const satisfies StreamChunk,
          ),
          runEnd,
        ]),
        getPhase: () => "settled",
        readTiming: async () => readPresent(running),
      }),
      {
        durability: {
          batch: batchSize,
          adapter: createChatTurnTimingDurability({
            getTerminal: () => ({ chunk: runEnd, messageId: "answer" }),
            getPhase: () => "settled",
            readTiming: async () => readPresent(finished),
            finishSettlement: async () => {
              expect(stored.at(-1)).toEqual(runEnd);
              for (const chunk of stored) {
                if (chunk.type === EventType.TEXT_MESSAGE_END) {
                  chunk.metadata = { turnTiming: finished };
                }
              }
            },
            log: {
              resumeFrom: () => null,
              append: async (chunks) => {
                const offsets = chunks.map((_chunk, index) =>
                  String(stored.length + index + 1),
                );
                stored.push(...structuredClone(chunks));
                return offsets;
              },
              async *read() {
                for (const [index, chunk] of stored.entries()) {
                  yield { offset: String(index + 1), chunk };
                }
              },
              close: async () => {},
              snapshot: async () =>
                stored.map((chunk, index) => ({
                  offset: String(index + 1),
                  chunk: structuredClone(chunk),
                })),
            },
          }),
        },
      },
    );
    const body = await response.text();
    const delivered = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line): unknown => JSON.parse(line.slice(6)));
    for (const chunk of stored) {
      capture.processor.processChunk(structuredClone(chunk));
    }
    expect(delivered).toEqual(stored);
    expect(capture.message()?.metadata?.["turnTiming"]).toEqual(finished);
    expect(capture.message()?.parts).toEqual([
      { type: "text", content: "x".repeat(30) },
    ]);
    expect(
      stored.filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_END),
    ).toHaveLength(1);
  });
}

for (const exit of ["drained", "thrown"] as const) {
  for (const batchSize of [1, 32]) {
    test(`final timing reaches live and replay on ${exit} source at batch ${batchSize}`, async () => {
      const stored: StreamChunk[] = [];
      let state: "running" | "settled" = "running";
      const capture = createStreamMessageCapture({
        initialMessages: [],
        capture: (message) => message,
      });
      const source = async function* () {
        yield runStart;
        yield starts[0];
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "answer",
          delta: "Partial",
        } as const satisfies StreamChunk;
        if (exit === "thrown") {
          throw new HandlerError({
            status: 500,
            message: "Synthetic source failure",
          });
        }
      };
      const response = toServerSentEventsResponse(
        withChatTurnTiming({
          source: source(),
          getPhase: () => state,
          readTiming: async () =>
            readPresent(state === "running" ? running : finished),
        }),
        {
          durability: {
            batch: batchSize,
            adapter: createChatTurnTimingDurability({
              getTerminal: () => undefined,
              getPhase: () => state,
              readTiming: async () =>
                readPresent(state === "running" ? running : finished),
              finishSettlement: async () => {
                state = "settled";
                for (const chunk of stored) {
                  if (chunk.type === EventType.TEXT_MESSAGE_END) {
                    chunk.metadata = { turnTiming: finished };
                  }
                }
              },
              log: {
                resumeFrom: () => null,
                append: async (chunks) => {
                  const offsets = chunks.map((_chunk, index) =>
                    String(stored.length + index + 1),
                  );
                  stored.push(...structuredClone(chunks));
                  return offsets;
                },
                async *read() {
                  for (const [index, chunk] of stored.entries()) {
                    yield { offset: String(index + 1), chunk };
                  }
                },
                close: async () => {},
                snapshot: async () =>
                  stored.map((chunk, index) => ({
                    offset: String(index + 1),
                    chunk: structuredClone(chunk),
                  })),
              },
            }),
          },
        },
      );
      const body = await response.text();
      const deliveredTimings: unknown[] = [];
      const deliveredErrors: string[] = [];
      for (const line of body.split("\n")) {
        if (!line.startsWith("data: ")) {
          continue;
        }
        const chunk: StreamChunk = JSON.parse(line.slice(6));
        capture.processor.processChunk(chunk);
        if (chunk.type === EventType.RUN_ERROR) {
          deliveredErrors.push(chunk.message);
        }
        if (chunk.type === EventType.TEXT_MESSAGE_END) {
          deliveredTimings.push(chunk.metadata?.["turnTiming"]);
        }
      }
      capture.processor.finalizeStream();
      expect(deliveredErrors).toEqual(exit === "thrown" ? ["unknown"] : []);
      expect(deliveredTimings.at(-1)).toEqual(finished);
      expect(capture.message()?.metadata?.["turnTiming"]).toEqual(finished);
      expect(capture.message()?.parts).toEqual([
        { type: "text", content: "Partial" },
      ]);
      const persistedTimings = stored
        .filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_END)
        .map((chunk) => chunk.metadata?.["turnTiming"]);
      expect(deliveredTimings).toEqual(persistedTimings);
    });
  }
}

test("a failed cleanup append still settles once and closes durability", async () => {
  const log = memoryStream({ runId: "cleanup-failure" });
  let writes = 0;
  let settlements = 0;
  let closes = 0;
  const failure = new HandlerError({
    status: 500,
    message: "Cleanup write failed",
  });
  const adapter = createChatTurnTimingDurability({
    log: {
      ...log,
      append: async (chunks) => {
        if (++writes > 1) {
          throw failure;
        }
        return await log.append(chunks);
      },
      close: async () => {
        closes += 1;
        await log.close();
      },
    },
    getTerminal: () => undefined,
    getPhase: () => "running",
    readTiming: async () => readPresent(finished),
    finishSettlement: async () => {
      settlements += 1;
    },
  });
  await adapter.append([starts[0]]);
  const closed = await Result.tryPromise(async () => await adapter.close());
  expect(Result.isError(closed)).toBe(true);
  if (Result.isError(closed)) {
    expect(closed.error.cause).toBe(failure);
  }
  expect(settlements).toBe(1);
  expect(closes).toBe(1);
});

test.each(["throw after terminal"] as const)(
  "settles all timing before releasing the execution fence on %s",
  async (exit) => {
    const log = memoryStream({ runId: `timing-fence-${exit}` });
    const phase: { status: "running" | "settled" } = { status: "running" };
    let rejectedWrites = 0;
    let settlements = 0;
    const source = async function* () {
      yield runStart;
      yield starts[0];
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "answer",
        delta: "First",
      } as const satisfies StreamChunk;
      yield runEnd;
      throw new HandlerError({
        status: 500,
        message: "Source cleanup failed after terminal",
      });
    };
    const response = toServerSentEventsResponse(
      withChatTurnTiming({
        source: source(),
        getPhase: () => phase.status,
        readTiming: async () =>
          readPresent(phase.status === "running" ? running : finished),
      }),
      {
        durability: {
          batch: 1,
          adapter: createChatTurnTimingDurability({
            log: {
              ...log,
              append: async (chunks) => {
                // Mirror the database writer's execution fence: settlement
                // removes ownership, so no subsequent append is legal.
                if (phase.status === "settled") {
                  rejectedWrites += 1;
                  throw new HandlerError({
                    status: 409,
                    message: "Chat run log execution fence lost",
                  });
                }
                return await log.append(chunks);
              },
            },
            getTerminal: () => ({ chunk: runEnd, messageId: "answer" }),
            getPhase: () => phase.status,
            readTiming: async () =>
              readPresent(phase.status === "running" ? running : finished),
            finishSettlement: async () => {
              settlements += 1;
              phase.status = "settled";
            },
          }),
        },
      },
    );
    const body = await response.text();
    const { processor } = createStreamMessageCapture({
      initialMessages: [],
      capture: (message) => message,
    });
    for (const line of body.split("\n")) {
      if (line.startsWith("data: ")) {
        processor.processChunk(JSON.parse(line.slice(6)));
      }
    }
    processor.finalizeStream();
    expect(rejectedWrites).toBe(0);
    expect(settlements).toBe(1);
    expect(body).not.toContain("RUN_ERROR");
    const messages = processor.getMessages();
    expect(messages.map((message) => message.metadata?.["turnTiming"])).toEqual(
      [finished],
    );
    expect(messages.flatMap((message) => message.parts)).toEqual([
      { type: "text", content: "First" },
    ]);
  },
);

for (const start of starts) {
  test(`rejects a second assistant id from ${start.type}`, async () => {
    const iterator = withChatTurnTiming({
      source: chunksOf([
        starts[0],
        {
          ...start,
          ...(start.type === EventType.TOOL_CALL_START
            ? { parentMessageId: "answer-two" }
            : { messageId: "answer-two" }),
        },
      ]),
      getPhase: () => "running",
      readTiming: async () => readPresent(running),
    })[Symbol.asyncIterator]();
    await iterator.next();
    expect(await rejectionOf(iterator.next())).toMatchObject({
      message: "Chat turn timing supports one assistant message",
    });
  });
}

test("durability rejects a second assistant id before writing it", async () => {
  const log = memoryStream({ runId: "single-assistant" });
  const adapter = createChatTurnTimingDurability({
    log,
    getTerminal: () => undefined,
    getPhase: () => "running",
    readTiming: async () => readPresent(running),
    finishSettlement: async () => {},
  });
  await adapter.append([starts[0]]);
  expect(
    await rejectionOf(
      adapter.append([{ ...starts[0], messageId: "answer-two" }]),
    ),
  ).toMatchObject({
    message: "Chat turn timing supports one assistant message",
  });
  expect(await log.snapshot()).toHaveLength(1);
});

test.each(["running", "settled"] as const)(
  "source failure is observed without changing a %s turn's wire outcome",
  async (phase) => {
    const logs = installRecordingLogger();
    const analytics = installRecordingAnalytics();
    const sentinel = "Synthetic private source sentinel";
    const observed = spyOn(failureObservation, "observeFailure");
    const failure = new HandlerError({ status: 500, message: sentinel });
    try {
      const source = async function* () {
        yield starts[0];
        if (phase === "settled") {
          yield runEnd;
        }
        throw failure;
      };
      const chunks: StreamChunk[] = [];
      for await (const chunk of withChatTurnTiming({
        source: source(),
        getPhase: () => phase,
        readTiming: async () =>
          readPresent(phase === "running" ? running : finished),
      })) {
        chunks.push(chunk);
      }
      expect(
        logs.records.some(
          (record) => record.message === "chat.turn.timing_source_failed",
        ),
      ).toBe(true);
      expect(observed).toHaveBeenCalledWith(failure, {
        sink: expect.objectContaining({
          event: "chat.turn.timing_source_failed",
        }),
      });
      expect(failure.message).toBe(sentinel);
      expect(JSON.stringify(chunks)).not.toContain(sentinel);
      const errors = chunks.filter(
        (chunk) => chunk.type === EventType.RUN_ERROR,
      );
      expect(errors).toEqual(
        phase === "running"
          ? [
              expect.objectContaining({
                type: EventType.RUN_ERROR,
                message: "unknown",
                code: "unknown",
                error: { message: "unknown", code: "unknown" },
              }),
            ]
          : [],
      );
      if (phase === "settled") {
        expect(chunks.at(-1)).toEqual(runEnd);
      }
    } finally {
      observed.mockRestore();
      logs.restore();
      analytics.restore();
    }
  },
);
