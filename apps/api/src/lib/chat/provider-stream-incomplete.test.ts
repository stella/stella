import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { describe, expect, test } from "bun:test";

import { classifyRunErrorChunk } from "@/api/handlers/chat/stream-chat";
import { aiHandlerError, classifyAIError } from "@/api/lib/ai-error";
import { withProviderStreamContract } from "@/api/lib/chat/provider-stream-contract";
import { failureSink, gradeFailure } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// A provider stream that stops before its answer finishes is the provider's
// blip, not this service's fault: it is named, graded transient, and told to
// the user as a cut-off reply they can send again.

const cutOffRunError = async (): Promise<
  Extract<StreamChunk, { type: EventType.RUN_ERROR }>
> => {
  const adapter = asTestRaw<AnyTextAdapter>({
    kind: "text",
    model: "model",
    name: "fixture",
    async *chatStream() {
      await Promise.resolve();
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message",
        delta: "The cass",
        timestamp: 1,
      };
    },
  });
  for await (const chunk of withProviderStreamContract(adapter).chatStream({
    logger: resolveDebugOption(false),
    messages: [],
    model: "model",
  })) {
    if (chunk.type === EventType.RUN_ERROR) {
      return chunk;
    }
  }
  throw new TypeError("The stream reported no run error");
};

describe("a provider stream that stops before it finishes", () => {
  test("reads the same when the adapter names it itself", () => {
    // TanStack's own code for a stream that ended early (TanStack/ai#1494).
    const error = Object.assign(new Error("stream ended"), {
      code: "incomplete-stream",
    });
    expect(classifyAIError(error)).toBe("provider_stream_incomplete");
  });

  test("is named, and graded transient", async () => {
    const chunk = await cutOffRunError();
    expect(classifyRunErrorChunk(chunk)).toBe("provider_stream_incomplete");

    const error = Object.assign(new Error(chunk.message), { code: chunk.code });
    expect(classifyAIError(error)).toBe("provider_stream_incomplete");
    const handlerError = aiHandlerError(error, {
      status: 500,
      message: "fallback",
    });
    expect(
      gradeFailure(
        readEvidence(handlerError),
        failureSink({ event: "chat.stream_failed", expected: [] }),
      ),
    ).toMatchObject({
      grade: "transient",
      reason: "provider_stream_incomplete",
    });
  });

  test("tells the caller the reply was cut off and can be tried again", async () => {
    const chunk = await cutOffRunError();
    const handlerError = aiHandlerError(
      Object.assign(new Error(chunk.message), { code: chunk.code }),
      { status: 500, message: "fallback" },
    );
    expect(handlerError.status).toBe(502);
    expect(handlerError.message).toBe(
      "The AI model's reply was cut off before it finished. Please try again.",
    );
  });
});
