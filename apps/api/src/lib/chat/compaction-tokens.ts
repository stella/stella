/**
 * Token arithmetic shared by every compaction call site.
 *
 * The send path weighs in-memory `ChatMessage`s; the background compactor
 * weighs persisted rows it has never hydrated. Both decisions are made against
 * the constants and the trigger/preserve resolution here, so the two views of
 * a thread cannot drift apart on the numbers that matter.
 */

const ESTIMATED_CHARS_PER_TOKEN = 4;
export const MESSAGE_OVERHEAD_TOKENS = 12;
export const FILE_PART_ESTIMATED_TOKENS = 8000;
export const DEFAULT_TRIGGER_TOKENS = 64_000;
export const DEFAULT_PRESERVE_TOKENS = 38_000;
/**
 * Upper bound on the per-model compaction trigger. Even a 1M-token model
 * checkpoints well before its hard limit: summaries stay cheap, the tail
 * we resummarize stays bounded, and provider latency/cost stay sane. The
 * lower bound is `DEFAULT_TRIGGER_TOKENS` (the historical single value).
 */
const MAX_TRIGGER_TOKENS = 200_000;
export const MAX_TEXT_PART_CHARS = 8000;
export const MAX_STRUCTURED_PART_CHARS = 4000;
/**
 * Canonical chars/4 token estimate. Shared with the prompt builders so the
 * meter's prompt/tool parts use the same estimator as the message parts.
 */
export const estimateTextTokens = (text: string): number =>
  Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);

/** The fewest summary tokens a compaction asks for, however short its input. */
const MIN_SUMMARY_TARGET_TOKENS = 400;
/** The most summary tokens a compaction asks for, however long its input. */
const MAX_SUMMARY_TARGET_TOKENS = 1600;
/** The share of the summarized input the summary may take. */
const SUMMARY_TARGET_INPUT_SHARE = 0.04;
/**
 * Ceiling headroom over the target, as a multiple of it: a model asked for N
 * words can overshoot, and an overshoot must still end as a whole summary.
 */
const SUMMARY_CEILING_HEADROOM_FACTOR = 2;
/**
 * Output reserved for reasoning. Compaction asks for no reasoning, but a model
 * that cannot turn it off still reasons at its lowest effort, and a provider
 * bills that reasoning against the same output ceiling as the summary.
 */
const COMPACTION_REASONING_RESERVE_TOKENS = 4096;
/** English prose runs about four tokens to three words. */
const WORDS_PER_TOKEN = 0.75;

/** What every compaction summarizer request sends, from one policy. */
export type CompactionGenerationRequest = {
  /**
   * A summary that reaches its output ceiling cannot replace its source
   * window: doing so would advance the checkpoint past content absent from
   * the summary.
   */
  finishPolicy: "require-complete";
  maxOutputTokens: number;
  /** The summarizer's own effort: compaction needs no deliberation. */
  reasoningEffort: "none";
  /** The caller's prompt, with the summary's length bound appended. */
  prompt: string;
};

/**
 * The request a compaction summarizer sends for `prompt`. The prompt bounds
 * the summary (a word target well under the ceiling, sized to the input), and
 * the ceiling leaves headroom over that target plus a reasoning reserve, so a
 * summary that follows its instruction always finishes inside the ceiling.
 * Every compaction call site builds its request here, so the ceiling, the
 * completion policy and the length the prompt asks for cannot drift apart.
 */
export const compactionGenerationRequest = (
  prompt: string,
): CompactionGenerationRequest => {
  const targetTokens = Math.min(
    MAX_SUMMARY_TARGET_TOKENS,
    Math.max(
      MIN_SUMMARY_TARGET_TOKENS,
      Math.ceil(estimateTextTokens(prompt) * SUMMARY_TARGET_INPUT_SHARE),
    ),
  );
  const targetWords = Math.floor(targetTokens * WORDS_PER_TOKEN);
  return {
    finishPolicy: "require-complete",
    maxOutputTokens:
      targetTokens * SUMMARY_CEILING_HEADROOM_FACTOR +
      COMPACTION_REASONING_RESERVE_TOKENS,
    reasoningEffort: "none",
    prompt: [
      prompt,
      "",
      `Keep the checkpoint summary under ${targetWords} words. Keep only what the next assistant needs; drop detail it can do without.`,
    ].join("\n"),
  };
};

/**
 * Per-model compaction trigger: half the model's documented input window,
 * clamped to `[DEFAULT_TRIGGER_TOKENS, MAX_TRIGGER_TOKENS]`. Half-window
 * leaves room for the reply plus the untrusted suffix and tool traffic the
 * estimate here does not model. An undefined window (unknown model) falls
 * back to the historical single trigger so behaviour never regresses.
 */
export const resolveCompactionTriggerTokens = (
  contextWindowTokens: number | undefined,
): number => {
  if (contextWindowTokens === undefined) {
    return DEFAULT_TRIGGER_TOKENS;
  }
  return Math.min(
    MAX_TRIGGER_TOKENS,
    Math.max(DEFAULT_TRIGGER_TOKENS, Math.floor(contextWindowTokens / 2)),
  );
};

/**
 * Scale the preserved-tail budget proportionally to the resolved trigger so
 * the summarize/keep ratio stays constant as the trigger grows with the
 * model's window.
 */
export const resolvePreserveTokensForTrigger = (
  triggerTokens: number,
): number =>
  Math.floor(
    (triggerTokens * DEFAULT_PRESERVE_TOKENS) / DEFAULT_TRIGGER_TOKENS,
  );

export const truncateForCompaction = (
  value: string,
  maxChars: number,
): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
};

export const renderTaggedValue = (tag: string, value: string): string =>
  `<${tag}>\n${value}\n</${tag}>`;

export const safeStringify = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  try {
    const serialized: unknown = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : "[unserializable]";
  } catch {
    return "[unserializable]";
  }
};
