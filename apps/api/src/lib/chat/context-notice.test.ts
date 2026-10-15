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
      const streamed = answerChunks().map((chunk, index) => {
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
    expect(chunks.map((chunk) => stamp.stamp(chunk))).toEqual(chunks);
    expect(liveAnswer(chunks).metadata?.["contextNotice"]).toBeUndefined();
    expect(stamp.metadata()).toEqual({});
  });
});
