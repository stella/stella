/**
 * The SQL twin of the citation-authority blend in rerank.ts.
 *
 * Only the corpus-index path blends in TypeScript. The Postgres paths have to
 * score inside the statement, because the keyset cursor predicate must be the
 * *same* expression as the ORDER BY or pagination skips or repeats rows. That
 * leaves one piece of arithmetic living in two runtimes, which is exactly the
 * shape ranking drift takes: authority saturated on one provider and raw on
 * another means the same decision ranks differently depending on which
 * provider served the query.
 *
 * So the constants are imported rather than retyped, every SQL ranking site
 * builds its score here instead of spelling out `+ 0.3 * authority`, and
 * `authority-sql.test.ts` executes these fragments against Postgres and
 * compares them to `saturateAuthority()` value by value.
 */

import { sql, type SQL } from "drizzle-orm";

import {
  AUTHORITY_PIVOT,
  DEFAULT_AUTHORITY_WEIGHT,
  DEFAULT_COURT_TIER_WEIGHT,
  HIGHEST_COURT_TIER,
  LOWEST_COURT_TIER,
} from "@/api/lib/legal-search/rerank";

/**
 * `saturateAuthority()` in SQL: `a / (a + pivot)`, clamped at zero.
 *
 * The authority expression is interpolated twice, so pass a column reference
 * or a LATERAL output rather than something that costs anything to evaluate.
 */
export const saturatedAuthoritySql = (authority: SQL): SQL =>
  sql`(GREATEST(${authority}, 0) / (GREATEST(${authority}, 0) + ${sql.raw(String(AUTHORITY_PIVOT))}))`;

/** What authority adds to a lexical score: `weight * saturate(authority)`. */
export const authorityBlendSql = (authority: SQL): SQL =>
  sql`(${sql.raw(String(DEFAULT_AUTHORITY_WEIGHT))} * ${saturatedAuthoritySql(authority)})`;

/**
 * `courtTierValue()` in SQL: the tier clamped to the registry's range and
 * mapped onto [0, 1]. The divisor is a float literal so integer tiers do not
 * divide to zero.
 */
export const courtTierValueSql = (tier: SQL): SQL =>
  sql`((LEAST(GREATEST(${tier}, ${sql.raw(String(LOWEST_COURT_TIER))}), ${sql.raw(String(HIGHEST_COURT_TIER))}) - ${sql.raw(String(LOWEST_COURT_TIER))})::float8
    / ${sql.raw(String(HIGHEST_COURT_TIER - LOWEST_COURT_TIER))}::float8)`;

/** What the deciding court adds to a lexical score: `weight * tierValue`. */
export const courtTierBlendSql = (tier: SQL): SQL =>
  sql`(${sql.raw(String(DEFAULT_COURT_TIER_WEIGHT))} * ${courtTierValueSql(tier)})`;

/**
 * The tier for a corpus that holds no decisions. A statute is not decided by
 * a court, so it sits at the tier every unranked court falls back to and the
 * term contributes nothing — the score stays lexical plus authority, exactly
 * as it was before the court-tier term existed.
 */
export const noCourtTierSql = (): SQL =>
  sql`${sql.raw(String(LOWEST_COURT_TIER))}`;

type BlendedRankOptions = {
  /** How much the decision is cited, raw; the fragment saturates it. */
  authority: SQL;
  /** The deciding court's tier, as the registry ranks it. */
  courtTier: SQL;
  lexicalRank: SQL;
};

/**
 * The blended ranking score: lexical relevance plus the bounded authority and
 * court-tier terms, the same two signals `blendStableCitationAuthority` adds.
 * Both the ORDER BY and the cursor predicate must interpolate this same value,
 * which is why every Postgres ranking path builds it once per statement and
 * reuses the fragment.
 */
export const blendedRankSql = ({
  authority,
  courtTier,
  lexicalRank,
}: BlendedRankOptions): SQL =>
  sql`(${lexicalRank} + ${authorityBlendSql(authority)} + ${courtTierBlendSql(courtTier)})`;
