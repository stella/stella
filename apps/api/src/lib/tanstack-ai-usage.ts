import type { StreamChunk, TokenUsage } from "@tanstack/ai";
import { tanstackMetadata } from "@tanstack/ai/adapter-internals";

type RunFinishedChunk = Extract<StreamChunk, { type: "RUN_FINISHED" }>;

const nonEmptyDetails = <T extends object>(details: T): T | undefined =>
  Object.keys(details).length === 0 ? undefined : details;

/**
 * Restore TanStack's rich token usage from its AG-UI wire projection.
 *
 * Run events may expose the provider/model-neutral counters in `usage[0]`
 * while keeping non-spec details in `metadata.tanstack.usage`. Older or
 * in-process adapters may still emit the rich TokenUsage object directly.
 */
export const tokenUsageFromRunFinishedChunk = (
  chunk: RunFinishedChunk,
): TokenUsage | undefined => {
  if (chunk.usage !== undefined && !Array.isArray(chunk.usage)) {
    return chunk.usage;
  }

  const spec = chunk.usage?.at(0);
  const leftover = tanstackMetadata(chunk)?.usage;
  if (spec === undefined && leftover === undefined) {
    return undefined;
  }

  const {
    promptTokensDetails: leftoverPromptDetails,
    completionTokensDetails: leftoverCompletionDetails,
    ...leftoverUsage
  } = leftover ?? {};
  const promptTokensDetails = nonEmptyDetails({
    ...(spec?.cachedInputTokens === undefined
      ? {}
      : { cachedTokens: spec.cachedInputTokens }),
    ...leftoverPromptDetails,
  });
  const completionTokensDetails = nonEmptyDetails({
    ...(spec?.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: spec.reasoningTokens }),
    ...leftoverCompletionDetails,
  });

  return {
    promptTokens: spec?.inputTokens ?? 0,
    completionTokens: spec?.outputTokens ?? 0,
    totalTokens: spec?.totalTokens ?? 0,
    ...leftoverUsage,
    ...(promptTokensDetails === undefined ? {} : { promptTokensDetails }),
    ...(completionTokensDetails === undefined
      ? {}
      : { completionTokensDetails }),
  };
};
