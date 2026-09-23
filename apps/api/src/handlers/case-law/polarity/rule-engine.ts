/**
 * Regex-based polarity classification engine.
 *
 * Loads polarity rules from the database, compiles them into
 * RegExp objects, and matches citation contexts against them.
 * Rules are partitioned by language for isolation.
 *
 * An optional cache can be passed to `loadRules` and `matchRule`
 * for batch scripts; the API server should omit it to stay
 * stateless (rules reload from DB on every call).
 */

import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawPolarityRules } from "@/api/db/schema";
import { aggregateMentionPolarities } from "@/api/handlers/case-law/polarity/aggregate";
import {
  CLASSIFIABLE_POLARITIES,
  isClassifiablePolarity,
  POLARITY_PRECEDENCE,
  RULE_SOURCE,
} from "@/api/handlers/case-law/polarity/consts";
import type {
  ClassifiablePolarity,
  Polarity,
} from "@/api/handlers/case-law/polarity/consts";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { TelemetryError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

export type CompiledRule = {
  id: SafeId<"caseLawPolarityRule">;
  regex: RegExp;
  /**
   * Narrower than the column, which the CHECK constraint still lets carry any
   * `Polarity`. A rule reads one mention, so it can neither assert that
   * classification did not happen (`unknown`) nor that two mentions disagreed
   * (`mixed`); both are the pipeline's own words about a citation.
   */
  polarity: ClassifiablePolarity;
  /** Kept for the specificity tiebreak; the compiled regex hides its length. */
  pattern: string;
  confidence: number;
};

/** The rule tier's label for one citation, over all of its mentions. */
export type CitationPolarityVerdict = {
  polarity: Polarity;
  ruleId: SafeId<"caseLawPolarityRule">;
  confidence: number;
};

/**
 * Order two rules that both match one context.
 *
 * Severity, then specificity, then id. Specificity is measured by pattern
 * length, which is coarse but monotone in the usual case: `na\s+rozdíl\s+od`
 * says more about a sentence than `viz`. The id tiebreak is what makes the
 * order total, so two rules of equal severity and length resolve the same way
 * on every run rather than following whatever order the rows arrived in.
 */
const compareRulePrecedence = (a: CompiledRule, b: CompiledRule): number => {
  const severity =
    POLARITY_PRECEDENCE[a.polarity] - POLARITY_PRECEDENCE[b.polarity];
  if (severity !== 0) {
    return severity;
  }

  const specificity = b.pattern.length - a.pattern.length;
  if (specificity !== 0) {
    return specificity;
  }

  if (a.id === b.id) {
    return 0;
  }

  return a.id < b.id ? -1 : 1;
};

/**
 * How many rules one polarity may contribute to the working set.
 *
 * The cap exists to bound the read, but which rules it drops is a
 * classification decision. Ordering it by `match_count` let a busy generic
 * rule push a rare negative one out of the working set entirely — the
 * shadowing bug one layer down from the match order. Ordering it by severity
 * instead would be no better: a language that accumulated a cap's worth of
 * negative rules would load nothing else, and every context those rules
 * missed would fall through to the LLM.
 *
 * So the budget is divided among the tiers rather than competed for. No tier
 * can starve another, and severity stays a matching concern, expressed once,
 * in `compareRulePrecedence`.
 *
 * The read stays bounded: at most this many rows per polarity present, so
 * the language-wide total is within rounding of the limit it divides.
 */
export const RULES_PER_POLARITY = Math.ceil(
  LIMITS.caseLawPolarityRulesPerLanguage / CLASSIFIABLE_POLARITIES.length,
);

/** Optional caller-owned cache for batch scripts. */
export type RuleCache = Map<string, CompiledRule[]>;

/** Compile a pattern string into a case-insensitive RegExp. */
const compilePattern = (pattern: string): RegExp | null => {
  try {
    return new RegExp(pattern, "iu");
  } catch {
    return null;
  }
};

/**
 * Active rule sources: proposed and retired rules are excluded.
 *
 * Exported because a verdict may only be published while the rule that
 * produced it still carries one of these, and the writer that checks it has
 * to be asking the question the loader asked. Two hand-kept lists would agree
 * until a source was added to one of them.
 */
export const ACTIVE_RULE_SOURCES = [
  RULE_SOURCE.MANUAL,
  RULE_SOURCE.LLM_PROMOTED,
];

/**
 * Active rules for one language, numbered within their own polarity.
 *
 * Ranking by pattern length keeps the most specific rules of each tier when
 * the per-tier budget bites, which is the same axis `compareRulePrecedence`
 * breaks ties on; the id makes the rank total, so a cap that bites lands on
 * the same rules on every run.
 *
 * Only the classifiable polarities are read. The CHECK constraint still lets
 * a row carry a polarity the pipeline derives, and one that did would
 * otherwise open a partition of its own — taking a share of a budget divided
 * among four, and, worse, matching: one mention would be labelled
 * "classification did not happen", or "the mentions disagreed", on its own.
 */
export const rankPolarityRulesByTier = (language: string) =>
  new QueryBuilder()
    .select({
      id: caseLawPolarityRules.id,
      pattern: caseLawPolarityRules.pattern,
      polarity: caseLawPolarityRules.polarity,
      confidence: caseLawPolarityRules.confidence,
      tierRank: sql<number>`row_number() over (
        partition by ${caseLawPolarityRules.polarity}
        order by length(${caseLawPolarityRules.pattern}) desc, ${caseLawPolarityRules.id}
      )`.as("tier_rank"),
    })
    .from(caseLawPolarityRules)
    .where(
      and(
        eq(caseLawPolarityRules.language, language),
        inArray(caseLawPolarityRules.source, ACTIVE_RULE_SOURCES),
        inArray(caseLawPolarityRules.polarity, CLASSIFIABLE_POLARITIES),
      ),
    )
    .as("ranked_polarity_rules");

/** The columns `compileRules` reads; the DB read that produces them is the caller's. */
type PolarityRuleRow = Pick<
  typeof caseLawPolarityRules.$inferSelect,
  "id" | "pattern" | "polarity" | "confidence"
>;

/**
 * Compile stored rules into the order they are matched in.
 *
 * A row is dropped, and reported, when it cannot take part in matching:
 * either its pattern does not compile, or it carries a polarity no match may
 * assign (outside `POLARITIES`, which the CHECK constraint forbids, or one
 * the pipeline derives, which the constraint permits but which is a word
 * about the citation rather than a reading of a mention). Both are reported
 * rather than dropped quietly, because such a row is a rule that can never
 * fire and still occupies its tier's budget: left invisible, it is
 * subtracted from the working set forever.
 *
 * The ranked query filters the polarity case out too. This is the guard that
 * does not depend on the caller having done so.
 */
export const compileRules = (
  rows: readonly PolarityRuleRow[],
): CompiledRule[] => {
  const compiled: CompiledRule[] = [];

  for (const row of rows) {
    const regex = compilePattern(row.pattern);
    if (!regex) {
      captureError(
        new TelemetryError({
          message: "Polarity rule pattern does not compile",
        }),
        { pattern: row.pattern, ruleId: row.id },
      );
      continue;
    }

    if (!isClassifiablePolarity(row.polarity)) {
      captureError(
        new TelemetryError({
          message: "Polarity rule carries a polarity no match may assign",
        }),
        { polarity: row.polarity, ruleId: row.id },
      );
      continue;
    }

    compiled.push({
      id: row.id,
      regex,
      polarity: row.polarity,
      pattern: row.pattern,
      confidence: row.confidence,
    });
  }

  return compiled.toSorted(compareRulePrecedence);
};

/**
 * The rule tier's verdict for one citation, or null when no rule reads it.
 *
 * `rules` must be in `compileRules` order, which is what makes the first
 * rule matching a window that window's label. The windows are the citation's
 * mentions in the citing decision (`extractContexts`): each is read on its
 * own, and `aggregateMentionPolarities` collapses the readings. So a
 * supportive recital followed by a rejection is stored `mixed` rather than
 * reduced to whichever mention outranked the other, and a citation whose
 * mentions agree keeps the label it always had.
 *
 * `ruleId` and `confidence` are the most severe contributing match's. A
 * `mixed` verdict has no single rule behind it; it is attributed to the
 * departure, because that is the reading whose rule, once retired, changes
 * the answer, and retiring a rule is what hands its citations back to the
 * classifier.
 */
export const selectCitationPolarity = (
  rules: readonly CompiledRule[],
  contexts: string | readonly string[],
): CitationPolarityVerdict | null => {
  const windows = typeof contexts === "string" ? [contexts] : contexts;
  const mentions: CompiledRule[] = [];
  for (const window of windows) {
    const rule = rules.find((candidate) => candidate.regex.test(window));
    if (rule) {
      mentions.push(rule);
    }
  }

  // Ranked, so the winner is the same rule the whole-citation walk used to
  // return and the aggregate's tiebreak is this tier's own.
  const [winner, ...rest] = mentions.toSorted(compareRulePrecedence);
  if (!winner) {
    return null;
  }

  return {
    polarity: aggregateMentionPolarities([
      winner.polarity,
      ...rest.map((rule) => rule.polarity),
    ]),
    ruleId: winner.id,
    confidence: winner.confidence,
  };
};

/**
 * Load and compile active rules for a language from the database.
 *
 * Only `manual` and `llm-promoted` rules are loaded; proposed
 * rules must accumulate surface forms before they become active.
 *
 * Pass a `cache` map to reuse compiled rules within a batch run.
 * Without a cache, rules are fetched from the database on every
 * call (stateless for the API server).
 *
 * Exported so a caller classifying a batch of citations against one
 * language pays the read once and then matches in memory with
 * {@link selectCitationPolarity}, instead of going through
 * {@link matchRule} per citation and relying on a cache to hide the
 * difference.
 */
export const loadRules = async (
  language: string,
  scopedDb: ScopedDb,
  cache?: RuleCache,
): Promise<CompiledRule[]> => {
  if (cache) {
    const cached = cache.get(language);
    if (cached) {
      return cached;
    }
  }

  const ranked = rankPolarityRulesByTier(language);

  const rows = await scopedDb((tx) =>
    tx
      .select({
        id: ranked.id,
        pattern: ranked.pattern,
        polarity: ranked.polarity,
        confidence: ranked.confidence,
      })
      .from(ranked)
      .where(lte(ranked.tierRank, RULES_PER_POLARITY)),
  );

  const compiled = compileRules(rows);

  cache?.set(language, compiled);
  return compiled;
};

/**
 * Match a citation's mentions against all active rules for a language.
 *
 * The read, then {@link selectCitationPolarity}. Returns null when no rule
 * reads any mention.
 */
export const matchRule = async (
  contexts: string | readonly string[],
  language: string,
  scopedDb: ScopedDb,
  cache?: RuleCache,
): Promise<CitationPolarityVerdict | null> =>
  selectCitationPolarity(await loadRules(language, scopedDb, cache), contexts);

/**
 * Record that a rule fired.
 *
 * Telemetry only: `match_count` reports how much work a rule is doing and
 * feeds rule curation. It carries no authority over classification, and in
 * particular must stay out of every ordering that decides which rule wins.
 */
type IncrementMatchCountArgs = {
  observedAt: Date;
  ruleId: SafeId<"caseLawPolarityRule">;
  scopedDb: ScopedDb;
};

export const incrementMatchCount = async ({
  observedAt,
  ruleId,
  scopedDb,
}: IncrementMatchCountArgs) => {
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive that the require-audit-on-mutation rule scans for inside this arrow's body range
  await scopedDb((tx) => {
    // audit: skip — background polarity classification pipeline; no user-facing state change
    return tx
      .update(caseLawPolarityRules)
      .set({
        matchCount: sql`${caseLawPolarityRules.matchCount} + 1`,
        updatedAt: sql`GREATEST(
          ${caseLawPolarityRules.updatedAt},
          ${observedAt}
        )`,
      })
      .where(eq(caseLawPolarityRules.id, ruleId));
  });
};
