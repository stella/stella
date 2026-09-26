import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  INCOMPLETE_STREAM_CODE,
  withProviderStreamContract,
} from "@/api/lib/chat/provider-stream-contract";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const started: StreamChunk = {
  type: EventType.RUN_STARTED,
  runId: "run",
  threadId: "thread",
  timestamp: 1,
};
const delta: StreamChunk = {
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: "message",
  delta: "The cass",
  timestamp: 1,
};
const failed: StreamChunk = {
  type: EventType.RUN_ERROR,
  message: "rate limited",
  timestamp: 1,
};
const finished: StreamChunk = {
  type: EventType.RUN_FINISHED,
  runId: "run",
  threadId: "thread",
  finishReason: "stop",
  timestamp: 1,
};

/** An adapter whose stream yields `chunks`, then throws when told to. */
const adapterOf = (
  chunks: readonly StreamChunk[],
  thenThrow = false,
): AnyTextAdapter =>
  asTestRaw<AnyTextAdapter>({
    kind: "text",
    model: "model",
    name: "fixture",
    label: () => "fixture",
    async *chatStream() {
      await Promise.resolve();
      yield* chunks;
      if (thenThrow) {
        panic("the provider connection dropped");
      }
    },
  });

const run = async (adapter: AnyTextAdapter, signal?: AbortSignal) => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of withProviderStreamContract(adapter).chatStream({
    logger: resolveDebugOption(false),
    messages: [],
    model: "model",
    ...(signal === undefined ? {} : { request: { signal } }),
  })) {
    chunks.push(chunk);
  }
  return chunks.map((chunk) =>
    chunk.type === EventType.RUN_ERROR
      ? `${chunk.type}:${chunk.code ?? ""}`
      : chunk.type,
  );
};

describe("the provider stream contract", () => {
  test("a stream that stops before its terminal event ends in a run error", async () => {
    expect(await run(adapterOf([started, delta]))).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_CONTENT",
      `RUN_ERROR:${INCOMPLETE_STREAM_CODE}`,
    ]);
  });

  test("a throw before the terminal event becomes the run error", async () => {
    expect(await run(adapterOf([started, delta], true))).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_CONTENT",
      "RUN_ERROR:",
    ]);
  });

  test("nothing follows the terminal event, thrown or yielded", async () => {
    expect(await run(adapterOf([started, failed, finished], true))).toEqual([
      "RUN_STARTED",
      "RUN_ERROR:",
    ]);
  });

  test("a cancelled run ends where the cancel left it", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await run(adapterOf([started, delta]), controller.signal)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_CONTENT",
    ]);
  });

  test("a reader that stops early closes the adapter's stream", async () => {
    let closed = false;
    const adapter = asTestRaw<AnyTextAdapter>({
      kind: "text",
      model: "model",
      name: "fixture",
      async *chatStream() {
        try {
          await Promise.resolve();
          yield started;
          yield delta;
          yield finished;
        } finally {
          closed = true;
        }
      },
    });
    for await (const chunk of withProviderStreamContract(adapter).chatStream({
      logger: resolveDebugOption(false),
      messages: [],
      model: "model",
    })) {
      if (chunk.type === EventType.RUN_STARTED) {
        break;
      }
    }
    expect(closed).toBe(true);
  });

  test("every other member is the adapter's own", () => {
    const adapter = adapterOf([]);
    const contracted = withProviderStreamContract(adapter);
    expect(contracted.name).toBe("fixture");
    expect(contracted.model).toBe("model");
  });
});
