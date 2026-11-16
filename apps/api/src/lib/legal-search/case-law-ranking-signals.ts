/**
 * The per-decision signals case-law search ranks by, written into every
 * passage of a generation that carries them (`case_law_v10` on), so a search
 * can blend its candidates from the engine's hits instead of reading a row per
 * candidate from PostgreSQL.
 *
 * What the blend needs per candidate, and where each value comes from:
 *
 * - citation authority: quantized into `CITATION_AUTHORITY_BUCKETS` buckets
 *   of its saturated value (`saturateAuthority` in `rerank.ts`), so the index
 *   follows the citation graph without re-projecting a decision every time
 *   decay moves its value by a sliver. Bucket 0 is exactly "uncited", which
 *   most decisions are, so their blend is exact.
 * - the deciding court's name, its directory id and the jurisdiction: the
 *   court tier is still resolved app-side from the operator-revisable
 *   registry (`decisionCourtWeight`); the index carries the inputs, never a
 *   tier, so revising the registry needs no rebuild.
 * - the language group key, which folds the language versions of a judgment
 *   into one result.
 * - whether a result can recur beyond the window that showed it: the passage
 *   count (a decision with more than one passage can) and whether another
 *   published decision shares its language group.
 *
 * The values that change after a decision is projected (the authority bucket
 * and the shared-group bit) are part of the projection fingerprint of a
 * generation that writes them, so the desired state of exactly the decisions
 * whose written value moved changes, and the coordinator re-projects those
 * and no others.
 */
import { panic } from "better-result";
import { type SQL, sql, type SQLWrapper } from "drizzle-orm";

/**
 * How many buckets the saturated authority, a value in [0, 1), is cut into.
 * The blend adds `DEFAULT_AUTHORITY_WEIGHT * saturate(authority)`; a bucket's
 * representative is its midpoint, so a bucketed blend sits within
 * `DEFAULT_AUTHORITY_WEIGHT / (2 * CITATION_AUTHORITY_BUCKETS)` of the exact
 * one (0.3 / 128 < 0.0024), below the position-score gap between two adjacent
 * top ranks (1 - exp(-1 / 300) > 0.0033).
 *
 * Part of the manifest of every generation that writes the bucket: changing
 * it is a new generation, never an edit.
 */
export const CITATION_AUTHORITY_BUCKETS = 64;

/** The bucket an uncited decision is in; its representative is exactly 0. */
export const UNCITED_AUTHORITY_BUCKET = 0;

/** The largest bucket a decision can be in. */
export const CITATION_AUTHORITY_BUCKET_MAX = CITATION_AUTHORITY_BUCKETS;

/**
 * The bucket of a stored citation authority: 0 for no authority (or a value
 * that is not a positive finite number, which the column cannot hold), else
 * `1 + floor(BUCKETS * (a / (a + 1)))`, capped at the last bucket.
 *
 * The saturation is taken before the scaling, so no authority overflows, and
 * the bucket count is a power of two, so the scaling is exact: the SQL twin
 * (`citationAuthorityBucketSql`) evaluates the same IEEE operations.
 */
export const citationAuthorityBucket = (authority: number): number => {
  if (!(authority > 0) || !Number.isFinite(authority)) {
    return UNCITED_AUTHORITY_BUCKET;
  }
  const cell = Math.floor(
    CITATION_AUTHORITY_BUCKETS * (authority / (authority + 1)),
  );
  return Math.min(1 + cell, CITATION_AUTHORITY_BUCKET_MAX);
};

/**
 * The saturated authority a bucket stands for: 0 for bucket 0, else the
 * midpoint of the bucket's interval on the saturated scale.
 */
export const saturatedAuthorityOfBucket = (bucket: number): number => {
  if (
    !Number.isSafeInteger(bucket) ||
    bucket < UNCITED_AUTHORITY_BUCKET ||
    bucket > CITATION_AUTHORITY_BUCKET_MAX
  ) {
    return panic(`Invalid citation authority bucket: ${bucket}`);
  }
  return bucket === UNCITED_AUTHORITY_BUCKET
    ? 0
    : (bucket - 1 + 0.5) / CITATION_AUTHORITY_BUCKETS;
};

/**
 * The raw authority a bucket stands for: the value whose saturation is the
 * bucket's representative, so a blend fed it saturates back to the midpoint.
 */
export const citationAuthorityOfBucket = (bucket: number): number => {
  const saturated = saturatedAuthorityOfBucket(bucket);
  return saturated / (1 - saturated);
};

/**
 * The largest difference between the authority term of a blend fed the exact
 * authority and one fed its bucket's representative, at weight 1. A
 * comparison of the two rankings is held to this, times the weight.
 */
export const CITATION_AUTHORITY_BUCKET_MAX_ERROR =
  1 / (2 * CITATION_AUTHORITY_BUCKETS);

/**
 * `citationAuthorityBucket` as SQL over a `double precision` expression, for
 * the database to tell which authority writes moved a bucket. Rendered from
 * the same constants, and `case-law-ranking-signals.test.ts` proves the two
 * agree on every bucket edge. PostgreSQL orders NaN above every number, so it
 * is named rather than left to the comparison.
 */
export const citationAuthorityBucketSql = (authority: SQLWrapper): SQL =>
  sql`(CASE
  WHEN ${authority} IS NULL
    OR NOT (${authority} > 0)
    OR ${authority} IN ('Infinity'::double precision, 'NaN'::double precision)
  THEN ${sql.raw(String(UNCITED_AUTHORITY_BUCKET))}
  ELSE least(
    1 + floor(${sql.raw(String(CITATION_AUTHORITY_BUCKETS))}::double precision * (${authority} / (${authority} + 1)))::integer,
    ${sql.raw(String(CITATION_AUTHORITY_BUCKET_MAX))}
  )
END)`;

/**
 * The index fields a generation that carries ranking signals maps. Every one
 * is stored and read back from a hit; none is indexed or fast, because nothing
 * filters, sorts or aggregates on them, and the docstore is the only place a
 * hit's fields come from.
 */
export const CASE_LAW_RANKING_SIGNAL_FIELDS = {
  citationAuthorityBucket: "citation_authority_bucket",
  courtId: "court_id",
  languageGroupKey: "language_group_key",
  languageGroupShared: "language_group_shared",
  passageCount: "passage_count",
} as const;

/**
 * The fields of every passage a ranking read takes from a hit beside the
 * signal fields: the court and jurisdiction, mapped by every case-law
 * generation and stored by one that carries signals.
 */
export const CASE_LAW_RANKING_STORED_BASE_FIELDS = [
  "court",
  "jurisdiction",
] as const;

/** Identity of the signal set; part of the manifest of a generation carrying it. */
export const CASE_LAW_RANKING_SIGNALS_VERSION = "case-law-ranking-signals-v1";

/**
 * The signals a projection input carries, read from PostgreSQL inside the
 * transaction that derives the decision's projection
 * (`readCaseLawRankingSignals`). Passage count is not here: the builder knows
 * it from the passages it writes.
 */
export type CaseLawRankingSignals = {
  /** `citationAuthorityBucket(case_law_decisions.citation_authority)`. */
  citationAuthorityBucket: number;
  languageGroupKey: string | null;
  /** Another published decision shares the language group key. */
  languageGroupShared: boolean;
};
