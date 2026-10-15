import { EventType, StreamProcessor } from "@tanstack/ai";
import type { StreamChunk, UIMessage } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import {
  createContextNoticeStamp,
  HISTORY_TRIMMED_NOTICE,
} from "@/api/lib/chat/context-notice";

const MESSAGE_ID = "answer";

const answerChunks = (): StreamChunk[] => [
  { type: EventType.RUN_STARTED, runId: "run", threadId: "thread" },
  {
    type: EventType.TEXT_MESSAGE_START,
    messageId: MESSAGE_ID,
    role: "assistant",
  },
  {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: MESSAGE_ID,
    delta: "The break ",
  },
  {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: MESSAGE_ID,
    delta: "needs six months' notice.",
  },
  { type: EventType.TEXT_MESSAGE_END, messageId: MESSAGE_ID },
  {
    type: EventType.RUN_FINISHED,
    runId: "run",
    threadId: "thread",
    finishReason: "stop",
  },
];

/** The answer as the browser's stream processor builds it. */
const liveAnswer = (chunks: readonly StreamChunk[]): UIMessage => {
  const captured: { message?: UIMessage } = {};
  const processor = new StreamProcessor({
    events: {
      onStreamEnd: (message) => {
        captured.message = message;
      },
    },
  });
  for (const chunk of chunks) {
    processor.processChunk(chunk);
  }
  processor.finalizeStream();
  if (captured.message === undefined) {
    throw new Error("The stream built no answer");
  }
  return captured.message;
};

describe("an answer's context notice", () => {
  // The notice is known before the answer (the send path's compaction) or
  // only after it started (a step's own); both must reach the live answer.
  for (const recordAt of [0, 3]) {
    test(`reads the same live as stored when recorded before chunk ${recordAt}`, () => {
      const stamp = createContextNoticeStamp(null);
      const streamed = answerChunks().flatMap((chunk, index) => {
        if (index === recordAt) {
          stamp.record(HISTORY_TRIMMED_NOTICE);
        }
        return stamp.stamp(chunk);
      });

      const live = liveAnswer(streamed);
      expect(live.metadata?.["contextNotice"]).toEqual(HISTORY_TRIMMED_NOTICE);
      expect(stamp.metadata()).toEqual({
        contextNotice: HISTORY_TRIMMED_NOTICE,
      });
      // Stamped once: the answer's text events do not all carry it.
      expect(
        streamed.filter(
          (chunk) =>
            "metadata" in chunk &&
            chunk.metadata !== undefined &&
            "contextNotice" in chunk.metadata,
        ),
      ).toHaveLength(1);
    });
  }

  test("leaves an answer without a notice untouched, live and stored", () => {
    const stamp = createContextNoticeStamp(null);
    const chunks = answerChunks();
    expect(chunks.flatMap((chunk) => stamp.stamp(chunk))).toEqual(chunks);
    expect(liveAnswer(chunks).metadata?.["contextNotice"]).toBeUndefined();
    expect(stamp.metadata()).toEqual({});
  });

  test("reaches an answer that opens with a tool call, live as stored", () => {
    const stamp = createContextNoticeStamp(null);
    stamp.record(HISTORY_TRIMMED_NOTICE);
    const chunks: StreamChunk[] = [
      { type: EventType.RUN_STARTED, runId: "run", threadId: "thread" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call-1",
        toolCallName: "ask_user",
        parentMessageId: MESSAGE_ID,
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "call-1", delta: "{}" },
      { type: EventType.TOOL_CALL_END, toolCallId: "call-1" },
      {
        type: EventType.RUN_FINISHED,
        runId: "run",
        threadId: "thread",
        finishReason: "tool_calls",
      },
    ];
    const streamed = chunks.flatMap((chunk) => stamp.stamp(chunk));

    const live = liveAnswer(streamed);
    expect(live.id).toBe(MESSAGE_ID);
    expect(live.metadata?.["contextNotice"]).toEqual(HISTORY_TRIMMED_NOTICE);
    // The carrier adds no text: the answer is the tool call alone.
    expect(live.parts.map(({ type }) => type)).toEqual(["tool-call"]);
    expect(stamp.metadata()).toEqual({
      contextNotice: HISTORY_TRIMMED_NOTICE,
    });
  });

  test("speaks only for the attempt that answers, keeping a notice known before the turn", () => {
    const stepOnly = createContextNoticeStamp(null);
    stepOnly.beginAttempt();
    stepOnly.record(HISTORY_TRIMMED_NOTICE);
    stepOnly.beginAttempt();
    const streamed = answerChunks().flatMap((chunk) => stepOnly.stamp(chunk));
    expect(stepOnly.metadata()).toEqual({});
    expect(liveAnswer(streamed).metadata?.["contextNotice"]).toBeUndefined();

    const preflight = createContextNoticeStamp(HISTORY_TRIMMED_NOTICE);
    preflight.beginAttempt();
    preflight.beginAttempt();
    expect(preflight.metadata()).toEqual({
      contextNotice: HISTORY_TRIMMED_NOTICE,
    });
  });

  // Both attempts stream into one browser answer: the first opens it and
  // stops before any content, then the fallback answers.
  const twoAttempts = (fallbackTrims: boolean) => {
    const stamp = createContextNoticeStamp(null);
    stamp.beginAttempt();
    stamp.record(HISTORY_TRIMMED_NOTICE);
    const first = stamp.stamp({
      type: EventType.TEXT_MESSAGE_START,
      messageId: MESSAGE_ID,
      role: "assistant",
    });
    stamp.beginAttempt();
    if (fallbackTrims) {
      stamp.record(HISTORY_TRIMMED_NOTICE);
    }
    const fallback = answerChunks()
      .slice(1)
      .flatMap((chunk) => stamp.stamp(chunk));
    return {
      live: liveAnswer([answerChunks()[0], ...first, ...fallback]),
      stored: stamp.metadata(),
    };
  };

  test("keeps the notice live when the answering attempt also trimmed", () => {
    const { live, stored } = twoAttempts(true);
    expect(live.metadata?.["contextNotice"]).toEqual(HISTORY_TRIMMED_NOTICE);
    expect(stored).toEqual({ contextNotice: HISTORY_TRIMMED_NOTICE });
  });

  test("withdraws a replaced attempt's notice when the answering attempt did not trim", () => {
    const { live, stored } = twoAttempts(false);
    // Withdrawn live (`null`), absent once stored: neither shows a notice.
    expect(live.metadata?.["contextNotice"]).toBeNull();
    expect(stored).toEqual({});
  });
});
