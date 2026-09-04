/**
 * Token arithmetic shared by every compaction call site.
 *
 * The send path weighs in-memory `ChatMessage`s; the background compactor
 * weighs persisted rows it has never hydrated. Both decisions are made against
 * the constants and the trigger/preserve resolution here, so the two views of
 * a thread cannot drift apart on the numbers that matter.
 */

export const ESTIMATED_CHARS_PER_TOKEN = 4;
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
 * A summary that reaches its output ceiling cannot replace its source window:
 * doing so would advance the checkpoint past content absent from the summary.
 * Keep the ceiling and completion policy inseparable at every compaction call.
 */
export const COMPACTION_GENERATION_POLICY = {
  finishPolicy: "require-complete",
  maxOutputTokens: 1800,
} as const;

/**
 * Canonical chars/4 token estimate. Shared with the prompt builders so the
 * meter's prompt/tool parts use the same estimator as the message parts.
 */
export const estimateTextTokens = (text: string): number =>
  Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);

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
