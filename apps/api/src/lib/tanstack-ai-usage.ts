import type {
  BilledUsage,
  CompletionTokensDetails,
  PromptTokensDetails,
  StreamChunk,
  TokenUsage,
  UsageCostBreakdown,
} from "@tanstack/ai";
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

const addCount = (
  total: number | undefined,
  step: number | undefined,
): number | undefined => {
  if (total === undefined) {
    return step;
  }
  return step === undefined ? total : total + step;
};

const PROMPT_TOKENS_DETAIL_KEYS = {
  audioTokens: true,
  cachedTokens: true,
  cacheWriteTokens: true,
  documentTokens: true,
  imageTokens: true,
  textTokens: true,
  videoTokens: true,
} as const satisfies Record<keyof PromptTokensDetails, true>;

const COMPLETION_TOKENS_DETAIL_KEYS = {
  audioTokens: true,
  documentTokens: true,
  imageTokens: true,
  reasoningTokens: true,
  textTokens: true,
  videoTokens: true,
} as const satisfies Record<keyof CompletionTokensDetails, true>;

const COST_DETAIL_KEYS = {
  upstreamCost: true,
  upstreamInputCost: true,
  upstreamOutputCost: true,
} as const satisfies Record<keyof UsageCostBreakdown, true>;

/** Sum two optional count breakdowns key by key, over a total key table. */
const addCounts = <TKey extends string>(
  keys: Record<TKey, true>,
  total: Partial<Record<TKey, number>> | undefined,
  step: Partial<Record<TKey, number>> | undefined,
): Partial<Record<TKey, number>> | undefined => {
  if (total === undefined) {
    return step;
  }
  if (step === undefined) {
    return total;
  }
  const sum: Partial<Record<TKey, number>> = {};
  for (const key in keys) {
    if (!Object.hasOwn(keys, key)) {
      continue;
    }
    const value = addCount(total[key], step[key]);
    if (value !== undefined) {
      sum[key] = value;
    }
  }
  return sum;
};

const addBilled = (
  total: BilledUsage | undefined,
  step: BilledUsage | undefined,
): BilledUsage | undefined => {
  if (total === undefined) {
    return step;
  }
  if (step === undefined) {
    return total;
  }
  // Quantities in different units do not add; the later step's stands.
  return total.unit === step.unit
    ? { quantity: total.quantity + step.quantity, unit: step.unit }
    : step;
};

/**
 * The SDK's deprecated `durationSeconds` and `unitsBilled` restate `billed`
 * without its unit; a summed run carries `billed` alone.
 */
type SummedTokenUsageField = Exclude<
  keyof TokenUsage,
  "durationSeconds" | "unitsBilled"
>;

/**
 * How each `TokenUsage` field combines across the steps of one run. Total over
 * the SDK type, so a field an SDK release adds fails typecheck here until its
 * combination is chosen, instead of dropping out of a multi-step total.
 */
const TOKEN_USAGE_ADDERS = {
  promptTokens: (total, step) => total.promptTokens + step.promptTokens,
  completionTokens: (total, step) =>
    total.completionTokens + step.completionTokens,
  totalTokens: (total, step) => total.totalTokens + step.totalTokens,
  promptTokensDetails: (total, step) =>
    addCounts(
      PROMPT_TOKENS_DETAIL_KEYS,
      total.promptTokensDetails,
      step.promptTokensDetails,
    ),
  completionTokensDetails: (total, step) =>
    addCounts(
      COMPLETION_TOKENS_DETAIL_KEYS,
      total.completionTokensDetails,
      step.completionTokensDetails,
    ),
  billed: (total, step) => addBilled(total.billed, step.billed),
  // Provider-shaped and not additive in general: the latest step's stands.
  providerUsageDetails: (total, step) =>
    step.providerUsageDetails ?? total.providerUsageDetails,
  cost: (total, step) => addCount(total.cost, step.cost),
  costDetails: (total, step) =>
    addCounts(COST_DETAIL_KEYS, total.costDetails, step.costDetails),
} as const satisfies {
  [TField in SummedTokenUsageField]-?: (
    total: TokenUsage,
    step: TokenUsage,
  ) => TokenUsage[TField];
};

/**
 * The usage of a run that spans several model steps (each tool round trip is
 * one provider call with its own RUN_FINISHED): every step's usage, summed.
 */
export const addTokenUsage = (
  total: TokenUsage | undefined,
  step: TokenUsage | undefined,
): TokenUsage | undefined => {
  if (total === undefined) {
    return step;
  }
  if (step === undefined) {
    return total;
  }
  const add = TOKEN_USAGE_ADDERS;
  const promptTokensDetails = add.promptTokensDetails(total, step);
  const completionTokensDetails = add.completionTokensDetails(total, step);
  const billed = add.billed(total, step);
  const providerUsageDetails = add.providerUsageDetails(total, step);
  const cost = add.cost(total, step);
  const costDetails = add.costDetails(total, step);
  return {
    promptTokens: add.promptTokens(total, step),
    completionTokens: add.completionTokens(total, step),
    totalTokens: add.totalTokens(total, step),
    ...(promptTokensDetails === undefined ? {} : { promptTokensDetails }),
    ...(completionTokensDetails === undefined
      ? {}
      : { completionTokensDetails }),
    ...(billed === undefined ? {} : { billed }),
    ...(providerUsageDetails === undefined ? {} : { providerUsageDetails }),
    ...(cost === undefined ? {} : { cost }),
    ...(costDetails === undefined ? {} : { costDetails }),
  };
};
