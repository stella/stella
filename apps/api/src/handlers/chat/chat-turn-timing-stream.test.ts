import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { withChatTurnTiming } from "@/api/handlers/chat/chat-turn-timing-stream";
import type { ChatTurnTiming } from "@/api/handlers/chat/types";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import { readPresent, readUnavailable } from "@/api/lib/errors/read-outcome";
import { buildWireSnapshot } from "@/api/tests/helpers/chat-fixtures";

import {
  createChatTurnTimingObserver,
  getChatTurnDurationMs,
} from "../../../../web/src/components/chat/chat-turn-duration.logic";

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
                  role: "assistant",
                  parts: [],
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
