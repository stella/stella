import { EventType } from "@tanstack/ai";
import type { StreamChunk, TokenUsage } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { tokenUsageFromRunFinishedChunk } from "@/api/lib/tanstack-ai-usage";

const runFinishedChunk = (
  usage: NonNullable<Extract<StreamChunk, { type: "RUN_FINISHED" }>["usage"]>,
  metadata?: Extract<StreamChunk, { type: "RUN_FINISHED" }>["metadata"],
) =>
  ({
    type: EventType.RUN_FINISHED,
    runId: "run-1",
    threadId: "thread-1",
    usage,
    ...(metadata === undefined ? {} : { metadata }),
  }) satisfies Extract<StreamChunk, { type: "RUN_FINISHED" }>;

describe("TanStack run usage normalization", () => {
  test("preserves an in-process rich usage object", () => {
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      completionTokensDetails: { reasoningTokens: 2 },
    } satisfies TokenUsage;

    expect(tokenUsageFromRunFinishedChunk(runFinishedChunk(usage))).toBe(usage);
  });

  test("rebuilds rich usage from the AG-UI counters and TanStack metadata", () => {
    expect(
      tokenUsageFromRunFinishedChunk(
        runFinishedChunk(
          [
            {
              inputTokens: 5,
              outputTokens: 3,
              totalTokens: 8,
              cachedInputTokens: 2,
              reasoningTokens: 1,
            },
          ],
          {
            tanstack: {
              usage: {
                providerUsageDetails: { cacheWriteTokens: 4 },
              },
            },
          },
        ),
      ),
    ).toEqual({
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      promptTokensDetails: { cachedTokens: 2 },
      completionTokensDetails: { reasoningTokens: 1 },
      providerUsageDetails: { cacheWriteTokens: 4 },
    });
  });
});
