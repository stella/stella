import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as v from "valibot";

import {
  caseLawDecisions,
  caseLawSitemapShards,
  caseLawSitemapTouches,
  caseLawSources,
} from "@/api/db/schema";
import { publishedCaseLawDecisionFor } from "@/api/lib/case-law/published-decisions-sql";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import {
  decisionBucketSqlFor,
  decisionMonthSqlFor,
  decisionYearSqlFor,
  SITEMAP_ALL_BUCKET,
  sitemapDocumentRepresentativeFor,
  sitemapLastModifiedSqlFor,
} from "@/api/lib/case-law/sitemap-shard-sql";
import {
  caseLawSitemapTouchClaimLock,
  tryLockCaseLawSitemapSnapshot,
} from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";

/** The most touches one fold claims: each is a few primary-key probes. */
export const SITEMAP_TOUCH_FOLD_BATCH_LIMIT = 2048;

/**
 * The oldest queued touches, each with whether its fold may take it now.
 *
 * A writer holds its decision's row lock from its update until it commits,
 * and its trigger queues the decision while holding it. Claiming a decision
 * takes a share lock on that row without waiting:
 * - granted: no writer is in flight on the decision, and every later writer
 *   waits for this fold to commit. The fold's next statement therefore reads
 *   every committed write, and a later write finds the touch deleted and
 *   queues a new one.
 * - skipped: a writer is in flight, so its write may not be visible yet. The
 *   touch stays queued for a later fold, which sees that write committed.
 * A decision no longer present has nothing to fold, so its touch may go.
 * The fold never waits on a decision, so it cannot deadlock with a writer.
 */
export const sitemapTouchClaimSql = (limit: number): SQL => sql`
  WITH batch AS MATERIALIZED (
    SELECT ${caseLawSitemapTouches.id} AS id, ${caseLawSitemapTouches.decisionId} AS decision_id
    FROM ${caseLawSitemapTouches}
    ORDER BY ${caseLawSitemapTouches.id}
    LIMIT ${limit}
  ), claimed AS MATERIALIZED (
    SELECT claim.id
    FROM ${caseLawDecisions} AS claim
    WHERE claim.id = ANY(ARRAY(SELECT decision_id FROM batch))
    ORDER BY claim.id
    ${caseLawSitemapTouchClaimLock()}
  ), present AS MATERIALIZED (
    SELECT stored.id
    FROM ${caseLawDecisions} AS stored
    WHERE stored.id = ANY(ARRAY(SELECT decision_id FROM batch))
  )
  SELECT batch.id::text AS touch_id, batch.decision_id::text AS decision_id,
    (claimed.id IS NOT NULL OR present.id IS NULL) AS foldable
  FROM batch
  LEFT JOIN claimed ON claimed.id = batch.decision_id
  LEFT JOIN present ON present.id = batch.decision_id
  ORDER BY batch.id
`;

/** An array literal, built only from identifiers the claim validated. */
const arrayLiteral = (values: readonly string[]) => `{${values.join(",")}}`;

/**
 * Raise the shards listing the claimed decisions and delete their touches, in
 * one statement.
 *
 * A touch is queued only for a published decision whose write moved nothing
 * a shard counts, so the decision's shard and every shard's size are as the
 * last recount left them; only its last modification can have advanced. The
 * statement reads each claimed decision as it is now and raises the listing
 * shard to the newest representative's `updated_at`, exactly as a recount
 * would. A decision that has since moved or left is the subject of a logged
 * month, whose recount writes its shards whole; a shard not listed yet waits
 * for that recount too. Raising is idempotent, so a touch a recount already
 * saw changes nothing, and the fold never counts a month.
 */
export const sitemapTouchFoldSql = ({
  touchIds,
  decisionIds,
}: {
  touchIds: readonly string[];
  decisionIds: readonly string[];
}): SQL => sql`
  WITH touched AS MATERIALIZED (
    SELECT
      ${caseLawDecisions.country} AS country,
      ${decisionYearSqlFor(caseLawDecisions)} AS year,
      ${decisionMonthSqlFor(caseLawDecisions)} AS month,
      ${decisionBucketSqlFor(caseLawDecisions)} AS bucket,
      ${sitemapLastModifiedSqlFor(caseLawDecisions)} AS last_modified_at
    FROM ${caseLawDecisions}
    INNER JOIN ${caseLawSources} ON ${caseLawSources.id} = ${caseLawDecisions.sourceId}
    WHERE ${caseLawDecisions.id} = ANY(${arrayLiteral(decisionIds)}::uuid[])
      AND ${publishedCaseLawDecisionFor(caseLawDecisions)}
      AND ${redistributableCaseLawSource}
      AND ${sitemapDocumentRepresentativeFor(caseLawDecisions)}
    GROUP BY 1, 2, 3, 4
  ), targets AS MATERIALIZED (
    -- A month lists either its "all" row or its bucket rows. The limit keeps
    -- each probe a primary-key descent rather than a join over every shard.
    SELECT listed.row_id, max(touched.last_modified_at) AS last_modified_at
    FROM touched
    CROSS JOIN LATERAL (
      SELECT shard.ctid AS row_id
      FROM ${caseLawSitemapShards} AS shard
      WHERE shard.country = touched.country
        AND shard.year = touched.year
        AND shard.month = touched.month
        AND shard.bucket IN (touched.bucket, ${SITEMAP_ALL_BUCKET})
        AND shard.last_modified_at < touched.last_modified_at
      LIMIT 2
    ) AS listed
    GROUP BY 1
  ), raised AS (
    -- The snapshot fence excludes every other shard writer, so the row ids
    -- read above still name the rows this statement raises.
    UPDATE ${caseLawSitemapShards} AS shard
    SET last_modified_at = (
      SELECT targets.last_modified_at FROM targets WHERE targets.row_id = shard.ctid
    )
    WHERE shard.ctid = ANY(ARRAY(SELECT row_id FROM targets))
    RETURNING 1
  ), retired AS (
    DELETE FROM ${caseLawSitemapTouches}
    WHERE ${caseLawSitemapTouches.id} = ANY(${arrayLiteral(touchIds)}::bigint[])
    RETURNING 1
  )
  SELECT (SELECT count(*)::int FROM retired) AS retired,
    (SELECT count(*)::int FROM raised) AS raised
`;

const claimRowSchema = v.object({
  touch_id: v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/u)),
  decision_id: v.pipe(v.string(), v.uuid()),
  foldable: v.boolean(),
});

const foldRowSchema = v.object({
  retired: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  raised: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export type SitemapTouchFold =
  /** Nothing queued; no lock was taken. */
  | { status: "empty" }
  /** A recount or a removal holds the shard fence; nothing was read. */
  | { status: "held" }
  | {
      status: "folded";
      /** Touches folded and deleted. */
      folded: number;
      /** Touches left queued behind a writer still in flight. */
      retained: number;
      /** Shard rows whose last modification rose. */
      raised: number;
      /** The batch was full, so more may be queued behind it. */
      full: boolean;
    };

/**
 * Fold one batch of at most `limit` queued touches inside the caller's
 * transaction, which must commit before the claimed share locks are useful
 * to anyone else. The shard fence is taken without waiting and skipped when
 * nothing is queued.
 */
export const foldCaseLawSitemapTouches = async (
  tx: Parameters<typeof tryLockCaseLawSitemapSnapshot>[0],
  limit: number,
): Promise<SitemapTouchFold> => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > SITEMAP_TOUCH_FOLD_BATCH_LIMIT
  ) {
    return panic(
      `Sitemap touch fold batch must be between 1 and ${SITEMAP_TOUCH_FOLD_BATCH_LIMIT}`,
    );
  }
  const queued = v.parse(
    v.object({ queued: v.boolean() }),
    executedRows(
      await tx.execute(
        sql`SELECT EXISTS (SELECT 1 FROM ${caseLawSitemapTouches}) AS queued`,
      ),
    ).at(0),
  ).queued;
  if (!queued) {
    return { status: "empty" };
  }
  if (!(await tryLockCaseLawSitemapSnapshot(tx))) {
    return { status: "held" };
  }
  const claimed = executedRows(
    await tx.execute(sitemapTouchClaimSql(limit)),
  ).map((row) => v.parse(claimRowSchema, row));
  const foldable = claimed.filter((row) => row.foldable);
  const retained = claimed.length - foldable.length;
  const full = claimed.length === limit;
  if (foldable.length === 0) {
    return { status: "folded", folded: 0, retained, raised: 0, full };
  }
  const folded = v.parse(
    foldRowSchema,
    executedRows(
      await tx.execute(
        sitemapTouchFoldSql({
          touchIds: foldable.map((row) => row.touch_id),
          decisionIds: foldable.map((row) => row.decision_id),
        }),
      ),
    ).at(0),
  );
  return {
    status: "folded",
    folded: folded.retired,
    retained,
    raised: folded.raised,
    full,
  };
};

/**
 * The queue's depth, read no further than `cap` rows, for the run's log line.
 */
export const readSitemapTouchDepth = async (
  db: { execute: (statement: SQL) => PromiseLike<unknown> },
  cap: number,
): Promise<number> =>
  v.parse(
    v.object({ depth: v.pipe(v.number(), v.safeInteger(), v.minValue(0)) }),
    executedRows(
      await db.execute(sql`
        SELECT count(*)::int AS depth
        FROM (SELECT 1 FROM ${caseLawSitemapTouches} LIMIT ${cap}) AS queued
      `),
    ).at(0),
  ).depth;
