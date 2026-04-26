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

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { caseLawPolarityRules } from "@/api/db/schema";
import {
  isValidPolarity,
  RULE_SOURCE,
} from "@/api/handlers/case-law/polarity/consts";
import type { Polarity } from "@/api/handlers/case-law/polarity/consts";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { TelemetryError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

type CompiledRule = {
  id: SafeId<"caseLawPolarityRule">;
  regex: RegExp;
  polarity: Polarity;
};

type RuleMatch = {
  ruleId: SafeId<"caseLawPolarityRule">;
  polarity: Polarity;
};

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

  const rows = await scopedDb((tx) =>
    tx
      .select()
      .from(caseLawPolarityRules)
      .where(
        and(
          eq(caseLawPolarityRules.language, language),
          inArray(caseLawPolarityRules.source, ACTIVE_SOURCES),
        ),
      )
      .orderBy(desc(caseLawPolarityRules.matchCount))
      .limit(LIMITS.caseLawPolarityRulesPerLanguage),
  );

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
    });
  }

  cache?.set(language, compiled);
  return compiled;
};

/**
 * Match a citation context against all active rules for a
 * language. Returns the first matching rule, or null.
 */
export const matchRule = async (
  context: string,
  language: string,
  scopedDb: ScopedDb,
  cache?: RuleCache,
): Promise<RuleMatch | null> => {
  const rules = await loadRules(language, scopedDb, cache);

  for (const rule of rules) {
    if (rule.regex.test(context)) {
      return { ruleId: rule.id, polarity: rule.polarity };
    }
  }

  return null;
};

/** Increment the match count for a rule. */
export const incrementMatchCount = async (
  ruleId: SafeId<"caseLawPolarityRule">,
  scopedDb: ScopedDb,
) => {
  await scopedDb((tx) =>
    tx
      .update(caseLawPolarityRules)
      .set({
        matchCount: sql`${caseLawPolarityRules.matchCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(caseLawPolarityRules.id, ruleId)),
  );
};
