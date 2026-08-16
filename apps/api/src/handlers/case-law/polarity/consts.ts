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

/**
 * Polarities that record the pipeline's own state rather than a reading of
 * the text. `unknown` means classification did not produce an answer — the
 * LLM call failed, or the row predates the classifier — so no classifier
 * may emit it and no rule may carry it.
 */
const PIPELINE_POLARITIES = [POLARITY.UNKNOWN] as const;

/** A polarity a classifier is allowed to assign to a citation. */
export type ClassifiablePolarity = Exclude<
  Polarity,
  (typeof PIPELINE_POLARITIES)[number]
>;

/**
 * The classifier codomain, derived from `POLARITIES` so both tiers share one
 * list. Deriving matters: the LLM's schema and the rule table used to be
 * written out separately, and they disagreed about `supportive`, so the same
 * phrase got one label from a regex rule and another from the model.
 */
export const CLASSIFIABLE_POLARITIES = POLARITIES.filter(
  (polarity): polarity is ClassifiablePolarity =>
    !includes(PIPELINE_POLARITIES, polarity),
);

/**
 * Whether a stored value is one a classifier may assign.
 *
 * Stricter than `isValidPolarity`, and deliberately so at the read boundary:
 * the CHECK constraint keeps values inside `POLARITIES`, but nothing stops a
 * row carrying `unknown`, which is the pipeline's word about itself.
 */
export const isClassifiablePolarity = (
  value: string,
): value is ClassifiablePolarity => includes(CLASSIFIABLE_POLARITIES, value);

/**
 * Order in which competing rule matches are resolved: lower wins.
 *
 * Severity first. A court that distinguishes or overrules a decision has
 * said something stronger than one that also happens to cite it approvingly,
 * so a negative match must never lose to a positive or supportive one.
 * `positive` and `supportive` are deliberately equal: they differ in how
 * explicit the reliance is, not in how strong it is.
 *
 * `matchCount` must never enter this order. Ordering by it is
 * self-reinforcing — every win raises the winner's precedence — so a common
 * generic rule ends up permanently shadowing a rare specific one.
 */
export const POLARITY_PRECEDENCE = {
  negative: 0,
  positive: 1,
  supportive: 1,
  neutral: 2,
  unknown: 3,
} as const satisfies Record<Polarity, number>;

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
