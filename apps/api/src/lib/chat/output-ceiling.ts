import type { StreamChunk } from "@tanstack/ai";

import type { TanStackAIProvider } from "@stll/ai-catalog";

import { tokenUsageFromTerminalChunk } from "@/api/lib/tanstack-ai-usage";
import { isRecord } from "@/api/lib/type-guards";

/**
 * The model option each provider's adapter reads a request's output ceiling
 * from. The request builder writes the ceiling under this key and the stream
 * contract reads it back from the same key, so the two cannot name different
 * options for one provider.
 */
export const OUTPUT_CEILING_OPTION = {
  anthropic: "max_tokens",
  bedrock: "max_completion_tokens",
  google: "maxOutputTokens",
  mistral: "max_tokens",
  openai: "max_output_tokens",
  openrouter: "maxCompletionTokens",
} as const satisfies Record<TanStackAIProvider, string>;

/** The output ceiling `modelOptions` set for `provider`, if they set one. */
export const requestedOutputCeiling = (
  provider: TanStackAIProvider,
  modelOptions: unknown,
): number | undefined => {
  if (!isRecord(modelOptions)) {
    return undefined;
  }
  const ceiling = modelOptions[OUTPUT_CEILING_OPTION[provider]];
  return typeof ceiling === "number" &&
    Number.isSafeInteger(ceiling) &&
    ceiling > 0
    ? ceiling
    : undefined;
};

type RunTerminalChunk = Extract<
  StreamChunk,
  { type: "RUN_ERROR" } | { type: "RUN_FINISHED" }
>;

/**
 * Whether the usage a run's terminal event reported shows the response spent
 * the whole output ceiling the request set. Reasoning a provider bills as
 * output counts toward the same ceiling, so a response whose reasoning used
 * the budget is one the ceiling cut as well.
 */
export const spentOutputCeiling = (
  chunk: RunTerminalChunk,
  ceiling: number | undefined,
): boolean => {
  if (ceiling === undefined) {
    return false;
  }
  const usage = tokenUsageFromTerminalChunk(chunk);
  return usage !== undefined && usage.completionTokens >= ceiling;
};
