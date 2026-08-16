import { describe, expect, test } from "bun:test";
import { lte } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { CLASSIFIABLE_POLARITIES } from "@/api/handlers/case-law/polarity/consts";
import {
  rankPolarityRulesByTier,
  RULES_PER_POLARITY,
} from "@/api/handlers/case-law/polarity/rule-engine";
import { LIMITS } from "@/api/lib/limits";

/**
 * The rule read is a window function assembled in code, so a mistake in it
 * produces SQL no type can reject. It runs in a background classifier, where
 * a malformed statement would surface as rules quietly failing to load rather
 * than as a failing request. Rendering through drizzle's dialect gives the
 * string the driver would send, without standing up a database.
 */
const ranked = rankPolarityRulesByTier("cs");
const rendered = new QueryBuilder()
  .select({ id: ranked.id })
  .from(ranked)
  .where(lte(ranked.tierRank, RULES_PER_POLARITY))
  .toSQL();

/** The window clause is written across lines; compare it as one. */
const statement = rendered.sql.replaceAll(/\s+/gu, " ");

describe("the polarity rule read caps each tier separately", () => {
  test("ranks within a polarity, not across the table", () => {
    // The partition is the whole point: without it the cap is a race between
    // tiers, and whichever tier grows fastest evicts the others.
    expect(statement).toContain('row_number() over ( partition by "polarity"');
  });

  test("keeps the most specific rules of each tier, deterministically", () => {
    expect(statement).toContain('order by length("pattern") desc, "id"');
  });

  test("applies the per-tier budget", () => {
    expect(rendered.sql).toContain('"tier_rank" <=');
    expect(rendered.params).toContain(RULES_PER_POLARITY);
  });

  test("no ordering reads match_count", () => {
    // The self-reinforcing order this engine used to have. It must not come
    // back through the cap, which is the subtler place for it to hide.
    expect(rendered.sql).not.toContain("match_count");
  });

  test("every tier gets a budget, and together they cover the limit", () => {
    expect(RULES_PER_POLARITY).toBeGreaterThan(0);
    expect(
      RULES_PER_POLARITY * CLASSIFIABLE_POLARITIES.length,
    ).toBeGreaterThanOrEqual(LIMITS.caseLawPolarityRulesPerLanguage);
  });
});
