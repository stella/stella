import type { ConstantMap } from "@/api/lib/constant-map";
import { includes } from "@/api/lib/type-guards";

/**
 * Citation polarity values. The list is the declaration: the CHECK constraints
 * that persist these derive from it, so a member reachable through the type but
 * missing from the list would be a value the write path accepts and the
 * database rejects.
 */
export const POLARITIES = [
  "positive",
  "supportive",
  "neutral",
  "negative",
  "unknown",
] as const;

export type Polarity = (typeof POLARITIES)[number];

export const POLARITY = {
  POSITIVE: "positive",
  SUPPORTIVE: "supportive",
  NEUTRAL: "neutral",
  NEGATIVE: "negative",
  UNKNOWN: "unknown",
} as const satisfies ConstantMap<Polarity>;

/** Rule source types, declared as the list the CHECK constraint derives from. */
export const RULE_SOURCES = ["manual", "llm-proposed", "llm-promoted"] as const;

export type RuleSource = (typeof RULE_SOURCES)[number];

export const RULE_SOURCE = {
  MANUAL: "manual",
  LLM_PROPOSED: "llm-proposed",
  LLM_PROMOTED: "llm-promoted",
} as const satisfies ConstantMap<RuleSource>;

/**
 * Number of consistent LLM classifications needed before
 * auto-promoting a surface form into a regex rule.
 */
export const PROMOTION_THRESHOLD = 5;

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
  includes(POLARITIES, value);

/**
 * Build a regex pattern from a key phrase.
 *
 * Wraps the phrase with optional whitespace flexibility.
 * Does NOT use grex; that's for when multiple surface
 * forms accumulate.
 */
export const phraseToPattern = (phrase: string): string => {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return escaped.replace(/\s+/gu, "\\s+");
};
