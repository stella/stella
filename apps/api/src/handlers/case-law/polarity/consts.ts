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
  "mixed",
  "unknown",
] as const;

export type Polarity = (typeof POLARITIES)[number];

export const POLARITY = {
  POSITIVE: "positive",
  SUPPORTIVE: "supportive",
  NEUTRAL: "neutral",
  NEGATIVE: "negative",
  MIXED: "mixed",
  UNKNOWN: "unknown",
} as const satisfies ConstantMap<Polarity>;

/**
 * Polarities the pipeline derives, which no single reading may emit.
 *
 * `unknown` records the pipeline's own state rather than a reading of the
 * text: classification did not produce an answer, because the LLM call failed
 * or the row predates the classifier.
 *
 * `mixed` is a reading, but of the citation rather than of any one mention of
 * it: it is what `aggregateMentionPolarities` returns when the citing court
 * departs from the decision at one mention and relies on it at another.
 * Neither belongs in the classifier codomain, so no rule may carry one and no
 * model may be offered one.
 */
const PIPELINE_POLARITIES = [POLARITY.MIXED, POLARITY.UNKNOWN] as const;

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
 * row carrying a polarity the pipeline derived rather than read.
 */
export const isClassifiablePolarity = (
  value: string,
): value is ClassifiablePolarity => includes(CLASSIFIABLE_POLARITIES, value);

/**
 * Order in which competing readings are resolved: lower wins. It settles
 * which rule match labels a mention, which mention labels a citation, and
 * whether a recheck's verdict is an improvement on the stored one.
 *
 * Severity first. A court that distinguishes or overrules a decision has
 * said something stronger than one that also happens to cite it approvingly,
 * so a negative match must never lose to a positive or supportive one.
 * `positive` and `supportive` are deliberately equal: they differ in how
 * explicit the reliance is, not in how strong it is.
 *
 * `mixed` sits between the two sides because it contains both: it carries a
 * departure, so it outranks every affirming reading, and it is not the plain
 * departure `negative` records, so it does not outrank that.
 *
 * `matchCount` must never enter this order. Ordering by it is
 * self-reinforcing — every win raises the winner's precedence — so a common
 * generic rule ends up permanently shadowing a rare specific one.
 */
export const POLARITY_PRECEDENCE = {
  negative: 0,
  mixed: 1,
  positive: 2,
  supportive: 2,
  neutral: 3,
  unknown: 4,
} as const satisfies Record<Polarity, number>;

/**
 * Rule source types, declared as the list the CHECK constraint derives from.
 * `retired` keeps a withdrawn rule's row (and its match telemetry) without
 * the loader ever compiling it again.
 */
export const RULE_SOURCES = [
  "manual",
  "llm-proposed",
  "llm-promoted",
  "retired",
] as const;

export type RuleSource = (typeof RULE_SOURCES)[number];

export const RULE_SOURCE = {
  MANUAL: "manual",
  LLM_PROPOSED: "llm-proposed",
  LLM_PROMOTED: "llm-promoted",
  RETIRED: "retired",
} as const satisfies ConstantMap<RuleSource>;

/**
 * Number of consistent LLM classifications needed before
 * auto-promoting a surface form into a regex rule.
 */
export const PROMOTION_THRESHOLD = 5;

/**
 * What each polarity contributes to citation authority.
 *
 * Binary on purpose. A court that overrules or distinguishes a decision is
 * not vouching for it, so a negative treatment confers no authority; every
 * other reading does, in full. `mixed` weighs as `negative` does: the citing
 * court departed somewhere, and a departure is not a vouch. That also keeps
 * the scores still as classification gets finer, because the citations now
 * labelled `mixed` were labelled `negative` before the label existed.
 *
 * Grading the middle (neutral below supportive below positive) would rank a
 * decision by how enthusiastically it happens to have been cited, and it
 * would make the score move as classification coverage grows rather than as
 * the case law changes.
 *
 * A citation with no polarity yet weighs the same as `unknown`: the corpus is
 * mostly unclassified, and anything else would rank unclassified citations
 * against classified ones instead of ranking decisions.
 *
 * This governs authority only. A negative treatment is still a citation: it
 * counts in `citation_count` and it is exactly what the citator must surface.
 */
export const POLARITY_AUTHORITY_WEIGHT = {
  positive: 1,
  supportive: 1,
  neutral: 1,
  negative: 0,
  mixed: 0,
  unknown: 1,
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
