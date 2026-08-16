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
import {
  CLASSIFIABLE_POLARITIES,
  isValidPolarity,
  POLARITY_PRECEDENCE,
  RULE_SOURCE,
} from "@/api/handlers/case-law/polarity/consts";
import type { Polarity } from "@/api/handlers/case-law/polarity/consts";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { TelemetryError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

export type CompiledRule = {
  id: SafeId<"caseLawPolarityRule">;
  regex: RegExp;
  polarity: Polarity;
  /** Kept for the specificity tiebreak; the compiled regex hides its length. */
  pattern: string;
  confidence: number;
};

export type RuleMatch = {
  ruleId: SafeId<"caseLawPolarityRule">;
  polarity: Polarity;
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

/** Active rule sources (proposed rules are excluded). */
const ACTIVE_SOURCES = [RULE_SOURCE.MANUAL, RULE_SOURCE.LLM_PROMOTED];

/**
 * Active rules for one language, numbered within their own polarity.
 *
 * Ranking by pattern length keeps the most specific rules of each tier when
 * the per-tier budget bites, which is the same axis `compareRulePrecedence`
 * breaks ties on; the id makes the rank total, so a cap that bites lands on
 * the same rules on every run.
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
        inArray(caseLawPolarityRules.source, ACTIVE_SOURCES),
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
 * Rows whose pattern does not compile are dropped; rows carrying a polarity
 * outside `POLARITIES` are dropped and reported, because the CHECK constraint
 * should have made them impossible.
 */
export const compileRules = (
  rows: readonly PolarityRuleRow[],
): CompiledRule[] => {
  const compiled: CompiledRule[] = [];

  for (const row of rows) {
    const regex = compilePattern(row.pattern);
    if (!regex) {
      continue;
    }

    if (!isValidPolarity(row.polarity)) {
      captureError(
        new TelemetryError({
          message: "Invalid polarity value in rule",
        }),
        { ruleId: row.id },
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

  return compiled.sort(compareRulePrecedence);
};

/**
 * The highest-precedence rule matching a context, or null.
 *
 * `rules` must be in `compileRules` order, which is what makes the first
 * match the winning one.
 */
export const selectRuleMatch = (
  rules: readonly CompiledRule[],
  context: string,
): RuleMatch | null => {
  for (const rule of rules) {
    if (rule.regex.test(context)) {
      return {
        ruleId: rule.id,
        polarity: rule.polarity,
        confidence: rule.confidence,
      };
    }
  }

  return null;
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
 */
const loadRules = async (
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
 * Match a citation context against all active rules for a language.
 *
 * Rules are held in `compareRulePrecedence` order, so the first match is the
 * highest-precedence match rather than whichever rule happened to be read
 * first. Returns null when nothing matches.
 */
export const matchRule = async (
  context: string,
  language: string,
  scopedDb: ScopedDb,
  cache?: RuleCache,
): Promise<RuleMatch | null> =>
  selectRuleMatch(await loadRules(language, scopedDb, cache), context);

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
