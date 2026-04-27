import { includes } from "@/api/lib/type-guards";

/** Citation polarity values. */
export const POLARITY = {
  POSITIVE: "positive",
  SUPPORTIVE: "supportive",
  NEUTRAL: "neutral",
  NEGATIVE: "negative",
  UNKNOWN: "unknown",
} as const;

export type Polarity = (typeof POLARITY)[keyof typeof POLARITY];

/** Rule source types. */
export const RULE_SOURCE = {
  MANUAL: "manual",
  LLM_PROPOSED: "llm-proposed",
  LLM_PROMOTED: "llm-promoted",
} as const;

export type RuleSource = (typeof RULE_SOURCE)[keyof typeof RULE_SOURCE];

/**
 * Number of consistent LLM classifications needed before
 * auto-promoting a surface form into a regex rule.
 */
export const PROMOTION_THRESHOLD = 5;

/**
 * Percentage of regex-matched citations to spot-check with
 * LLM for rule confidence tracking.
 *
 * TODO: not yet wired into the classification pipeline;
 * tracked for the confidence-decay iteration.
 */
export const SPOT_CHECK_RATE = 0.05;

/** Polarity weights for citation scoring. */
export const POLARITY_WEIGHT = {
  positive: 1,
  supportive: 0.8,
  neutral: 0.5,
  negative: 0,
  unknown: 0.5,
} as const satisfies Record<Polarity, number>;

/**
 * Check if a string is a valid polarity value.
 */
export const isValidPolarity = (value: string): value is Polarity =>
  includes(Object.values(POLARITY), value);

/**
 * Build a regex pattern from a key phrase.
 *
 * Wraps the phrase with optional whitespace flexibility.
 * Does NOT use grex; that's for when multiple surface
 * forms accumulate.
 */
export const phraseToPattern = (phrase: string): string => {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(/\s+/g, "\\s+");
};
