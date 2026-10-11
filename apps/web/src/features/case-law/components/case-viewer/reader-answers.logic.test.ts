import { describe, expect, test } from "bun:test";

import type {
  ReaderAnswer,
  ReaderAnswerStreamEvent,
} from "@stll/api-contract/reader-answers";

import { toSafeId } from "@/lib/safe-id";

import {
  applyReaderAnswerEvent,
  consumeReaderAnswerStream,
  ReaderAnswerFailure,
} from "./reader-answers.logic";

const now = "2026-10-10T12:00:00.000Z";
const answerFixture = (): ReaderAnswer => ({
  id: toSafeId<"legalReaderAnswer">("answer"),
  decisionId: toSafeId<"caseLawDecision">("decision"),
  authorId: toSafeId<"user">("author"),
  mine: true,
  kind: "explain",
  visibility: "private",
  anchor: { paragraphId: "p1", quote: "quote", startOffset: 0, endOffset: 5 },
  createdAt: now,
  updatedAt: now,
  messages: [
    {
      id: toSafeId<"legalReaderAnswerMessage">("old"),
      role: "assistant",
      content: "old answer",
      citations: [],
      status: "complete",
      errorCode: null,
      invalidCitationCount: 0,
      model: "model",
      usage: null,
      createdAt: now,
      updatedAt: now,
    },
  ],
});
const started = {
  type: "started",
  answerId: toSafeId<"legalReaderAnswer">("answer"),
  messageId: toSafeId<"legalReaderAnswerMessage">("new"),
} as const satisfies ReaderAnswerStreamEvent;
const streamOf = (events: ReaderAnswerStreamEvent[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const wire = events
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("");
      for (let index = 0; index < wire.length; index += 7) {
        controller.enqueue(encoder.encode(wire.slice(index, index + 7)));
      }
      controller.close();
    },
  });

describe("reader answer stream lifecycle", () => {
  test("regenerate replaces the assistant id and a failed terminal preserves sanitized reload content", async () => {
    let answer = answerFixture();
    const citations = [
      {
        decisionId: toSafeId<"caseLawDecision">("decision"),
        paragraphId: "p2",
      },
    ];
    const failed = {
      type: "failed",
      errorCode: "provider-error",
      messageId: started.messageId,
      message: "Model failed",
      content: "sanitized partial",
      citations,
      invalidCitationCount: 1,
    } as const satisfies ReaderAnswerStreamEvent;
    const result = await consumeReaderAnswerStream({
      body: streamOf([
        started,
        {
          type: "delta",
          messageId: started.messageId,
          delta: "unvalidated partial",
        },
        failed,
      ]),
      signal: new AbortController().signal,
      onEvent: (event) => {
        answer = applyReaderAnswerEvent({
          answer,
          event,
          regenerate: true,
          now,
        });
      },
    });
    expect(result.isOk()).toBe(true);
    expect(answer.messages).toHaveLength(1);
    expect(answer.messages.at(0)).toMatchObject({
      id: "new",
      content: failed.content,
      citations,
      status: "failed",
    });
    expect(answer.messages.some((message) => message.id === "old")).toBe(false);
  });

  test("follow-up appends an assistant and complete replaces deltas with the authoritative payload", async () => {
    let answer = answerFixture();
    const result = await consumeReaderAnswerStream({
      body: streamOf([
        started,
        { type: "delta", messageId: started.messageId, delta: "draft" },
        {
          type: "complete",
          messageId: started.messageId,
          content: "validated",
          citations: [],
          invalidCitationCount: 0,
          model: "model",
          usage: null,
        },
      ]),
      signal: new AbortController().signal,
      onEvent: (event) => {
        answer = applyReaderAnswerEvent({
          answer,
          event,
          regenerate: false,
          now,
        });
      },
    });
    expect(result.isOk()).toBe(true);
    expect(answer.messages.map((message) => message.content)).toEqual([
      "old answer",
      "validated",
    ]);
    expect(answer.messages.at(-1)?.status).toBe("complete");
  });

  test("returns typed failures for truncated streams and mismatched message ownership", async () => {
    const truncated = await consumeReaderAnswerStream({
      body: streamOf([started]),
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    expect(truncated.isErr()).toBe(true);
    if (truncated.isErr()) {
      expect(truncated.error).toBeInstanceOf(ReaderAnswerFailure);
      expect(truncated.error.message).toBe(
        "Reader answer stream ended before completion",
      );
    }
    const mismatched = await consumeReaderAnswerStream({
      body: streamOf([
        started,
        {
          type: "delta",
          messageId: toSafeId<"legalReaderAnswerMessage">("other"),
          delta: "wrong",
        },
      ]),
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    expect(mismatched.isErr()).toBe(true);
    if (mismatched.isErr()) {
      expect(mismatched.error).toMatchObject({
        message: "Reader answer stream message mismatch",
      });
    }
  });

  test("invalid protocol frames stop dispatch and cancel the stream", async () => {
    for (const wire of [
      "data: invalid-json\n\n",
      'data: {"type":"unknown"}\n\n',
      `event: delta\ndata: ${JSON.stringify(started)}\n\n`,
      `data: ${JSON.stringify(started)}\n\ndata: ${JSON.stringify(started)}\n\n`,
    ]) {
      const events: ReaderAnswerStreamEvent[] = [];
      const lifecycle = { cancelled: false };
      const result = await consumeReaderAnswerStream({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(wire));
          },
          cancel() {
            lifecycle.cancelled = true;
          },
        }),
        signal: new AbortController().signal,
        onEvent: (event) => {
          events.push(event);
        },
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ReaderAnswerFailure);
      }
      expect(events.length).toBeLessThanOrEqual(1);
      expect(lifecycle.cancelled).toBe(true);
    }
  });

  test("cancelled streams do not dispatch frames or report truncation", async () => {
    const controller = new AbortController();
    controller.abort();
    const events: ReaderAnswerStreamEvent[] = [];
    const result = await consumeReaderAnswerStream({
      body: streamOf([started]),
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(result.isOk()).toBe(true);
    expect(events).toEqual([]);
  });
});
