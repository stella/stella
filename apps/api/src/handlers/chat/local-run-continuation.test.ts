import { EventType, StreamProcessor } from "@tanstack/ai";
import type { StreamChunk, UIMessage } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { HARNESS_CONTINUATION_EVENT } from "@stll/agent-engine";

import { reportsSessionNotResumed } from "@/api/handlers/chat/local-run-chunks";
import {
  createContextNoticeStamp,
  SESSION_NOT_RESUMED_NOTICE,
} from "@/api/lib/chat/context-notice";

const continuation = (value: unknown): StreamChunk => ({
  type: EventType.CUSTOM,
  name: HARNESS_CONTINUATION_EVENT,
  value,
});

const RESUME_UNAVAILABLE = {
  type: "resume_unavailable",
  reason: "session_not_found",
  message: "The session could not be found.",
};

/** A local turn as its harness reports it, opening with its continuation. */
const localTurn = (value: unknown): StreamChunk[] => [
  { type: EventType.RUN_STARTED, runId: "run", threadId: "thread" },
  continuation(value),
  {
    type: EventType.TEXT_MESSAGE_START,
    messageId: "answer",
    role: "assistant",
  },
  {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "answer",
    delta: "The lease ends in May.",
  },
  { type: EventType.TEXT_MESSAGE_END, messageId: "answer" },
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

/** The turn through the chat's notice, as the chat stream records it. */
const answered = (chunks: readonly StreamChunk[]) => {
  const stamp = createContextNoticeStamp(null);
  const streamed = chunks.flatMap((chunk) => {
    if (reportsSessionNotResumed(chunk)) {
      stamp.record(SESSION_NOT_RESUMED_NOTICE);
    }
    return stamp.stamp(chunk);
  });
  return { live: liveAnswer(streamed), stored: stamp.metadata() };
};

describe("a local turn whose harness could not resume its session", () => {
  for (const reason of ["session_not_found", "resume_rejected"]) {
    test(`says so live and once stored (${reason})`, () => {
      const { live, stored } = answered(
        localTurn({ ...RESUME_UNAVAILABLE, reason }),
      );
      expect(live.metadata?.["contextNotice"]).toEqual(
        SESSION_NOT_RESUMED_NOTICE,
      );
      expect(stored).toEqual({ contextNotice: SESSION_NOT_RESUMED_NOTICE });
    });
  }

  test("a fresh or resumed session says nothing", () => {
    for (const value of [{ type: "fresh" }, { type: "resumed" }]) {
      const { live, stored } = answered(localTurn(value));
      expect(live.metadata?.["contextNotice"]).toBeUndefined();
      expect(stored).toEqual({});
    }
  });

  test("only the continuation event names a lost session", () => {
    expect(
      reportsSessionNotResumed({
        type: EventType.CUSTOM,
        name: "codex.session-id",
        value: RESUME_UNAVAILABLE,
      }),
    ).toBe(false);
    expect(reportsSessionNotResumed(continuation("resume_unavailable"))).toBe(
      false,
    );
  });
});
