import { EventType } from "@tanstack/ai";
import type { AdapterYieldChunk } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { MOCK_AI_STREAM_KIND_MARKERS } from "@/api/dev/mock-ai-stream-kind-markers";
import type { MockAiStreamKind } from "@/api/dev/mock-ai-stream-kind-markers";
import {
  mockAiStreamKindChunks,
  mockAiStreamKindOf,
} from "@/api/dev/mock-ai-stream-kinds";

// Each marker makes the mock model stream its kind as many tiny deltas: the
// e2e render budget spec only tells a page that commits per delta from one
// that does not when the deltas are many.

/** The event a kind's run streams many of. A tool's output and a subagent's
 *  run come from the engine, once the model has made its calls. */
const STREAMED_EVENT = {
  reasoning: { count: 300, type: EventType.REASONING_MESSAGE_CONTENT },
  status: { count: 150, type: EventType.STEP_STARTED },
  subagent: { count: 1, type: EventType.TOOL_CALL_START },
  text: { count: 300, type: EventType.TEXT_MESSAGE_CONTENT },
  "tool-input": { count: 300, type: EventType.TOOL_CALL_ARGS },
  "tool-output": { count: 60, type: EventType.TOOL_CALL_START },
} as const satisfies Record<
  MockAiStreamKind,
  { count: number; type: AdapterYieldChunk["type"] }
>;

const KINDS = Object.keys(MOCK_AI_STREAM_KIND_MARKERS).filter(
  (kind): kind is MockAiStreamKind => kind in MOCK_AI_STREAM_KIND_MARKERS,
);

const run = async (kind: MockAiStreamKind) => {
  const chunks: AdapterYieldChunk[] = [];
  for await (const chunk of mockAiStreamKindChunks(kind, {
    messageId: "mock-message",
    messages: [{ content: MOCK_AI_STREAM_KIND_MARKERS[kind], role: "user" }],
    model: "mock",
    runId: "mock-run",
    threadId: "mock-thread",
    timestamp: 0,
    usage: { completionTokens: 1, promptTokens: 1, totalTokens: 2 },
  })) {
    chunks.push(chunk);
  }
  return chunks;
};

describe("the mock model's stream kinds", () => {
  test("each marker names its own kind, and no other", () => {
    expect(
      KINDS.map((kind) =>
        mockAiStreamKindOf(MOCK_AI_STREAM_KIND_MARKERS[kind]),
      ),
    ).toEqual(KINDS);
    expect(mockAiStreamKindOf("Draft the NDA")).toBeUndefined();
  });

  test.each(KINDS)(
    "%s streams its kind as many deltas, then ends the run",
    async (kind) => {
      const chunks = await run(kind);
      const { count, type } = STREAMED_EVENT[kind];
      expect(chunks.filter((chunk) => chunk.type === type).length).toBe(count);
      expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    },
    10_000,
  );
});
