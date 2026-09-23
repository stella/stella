import { EventType } from "@tanstack/ai";
import type { StreamChunk, TokenUsage } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import {
  addTokenUsage,
  tokenUsageFromRunFinishedChunk,
} from "@/api/lib/tanstack-ai-usage";

type RunFinishedChunkOptions = Pick<
  Extract<StreamChunk, { type: "RUN_FINISHED" }>,
  "metadata" | "usage"
>;

const runFinishedChunk = ({ metadata, usage }: RunFinishedChunkOptions) =>
  ({
    type: EventType.RUN_FINISHED,
    runId: "run-1",
    threadId: "thread-1",
    ...(usage === undefined ? {} : { usage }),
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

    expect(tokenUsageFromRunFinishedChunk(runFinishedChunk({ usage }))).toBe(
      usage,
    );
  });

  test("rebuilds rich usage from the AG-UI counters and TanStack metadata", () => {
    expect(
      tokenUsageFromRunFinishedChunk(
        runFinishedChunk({
          usage: [
            {
              inputTokens: 5,
              outputTokens: 3,
              totalTokens: 8,
              cachedInputTokens: 2,
              reasoningTokens: 1,
            },
          ],
          metadata: {
            tanstack: {
              usage: {
                providerUsageDetails: { cacheWriteTokens: 4 },
              },
            },
          },
        }),
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

  test("rebuilds rich usage when only TanStack metadata is present", () => {
    expect(
      tokenUsageFromRunFinishedChunk(
        runFinishedChunk({
          metadata: {
            tanstack: {
              usage: {
                providerUsageDetails: { cacheWriteTokens: 4 },
              },
            },
          },
        }),
      ),
    ).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      providerUsageDetails: { cacheWriteTokens: 4 },
    });
  });
});

describe("usage across the steps of one run", () => {
  test("sums counts, breakdowns and cost, keeping the latest provider details", () => {
    const toolStep = {
      promptTokens: 100,
      completionTokens: 5,
      totalTokens: 105,
      promptTokensDetails: { cachedTokens: 60 },
      completionTokensDetails: { reasoningTokens: 3 },
      providerUsageDetails: { step: 1 },
      cost: 0.25,
    } satisfies TokenUsage;
    const answerStep = {
      promptTokens: 130,
      completionTokens: 40,
      totalTokens: 170,
      promptTokensDetails: { cachedTokens: 100, cacheWriteTokens: 20 },
      completionTokensDetails: { reasoningTokens: 7 },
      providerUsageDetails: { step: 2 },
      cost: 0.5,
    } satisfies TokenUsage;

    expect(
      addTokenUsage(addTokenUsage(undefined, toolStep), answerStep),
    ).toEqual({
      promptTokens: 230,
      completionTokens: 45,
      totalTokens: 275,
      promptTokensDetails: { cachedTokens: 160, cacheWriteTokens: 20 },
      completionTokensDetails: { reasoningTokens: 10 },
      providerUsageDetails: { step: 2 },
      cost: 0.75,
    });
  });

  test("keeps the running total when a step reports no usage", () => {
    const step = {
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    } satisfies TokenUsage;

    expect(addTokenUsage(step, undefined)).toEqual(step);
  });
});
