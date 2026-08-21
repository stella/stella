/**
 * A standing count of where citation resolution stands, per jurisdiction
 * and court, so a kind of ambiguity the resolver has no rule for shows up as
 * a number rather than waiting for someone to click on a row.
 *
 * The resolver already records its negative findings: every key it cannot
 * link honestly is `ambiguous`. What was missing is a reader of that pool.
 * Two questions matter, and both are about populations, not rows:
 *
 * - Which rule is doing the work, where. Each resolved row names the rule
 *   that drew its edge, and a rule is a hypothesis about how a court files
 *   its decisions; the count per (country, court, rule) is what lets a rule
 *   that starts firing in a place it was never meant for be noticed.
 * - What the ambiguous pool is made of. Each ambiguous key is classified
 *   into a *shape* from its bounded candidate set: the same holders the
 *   resolver reads, asked the structural question rather than the
 *   linking one. A shape some rule owns is backlog; a shape no rule owns
 *   is a jurisdiction telling us how it files, in numbers.
 *
 * Every run is a snapshot kept in its own rows, so the next one can be
 * compared with it. A run is two keyset walks, each one bounded batch per
 * invocation and resumed from a cursor kept on the run: first over every
 * precedent citation for the status and rule counts, then over every
 * ambiguous key for its shape. Both read one population: rows whose last
 * resolution attempt is not after the run's `started_at`. Rows settled later
 * belong to the next run, so the two walks agree with each other however
 * long the run takes, and no statement ever reads the whole table.
 */

import { panic } from "better-result";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import {
  caseLawCitationResolutionCensus,
  caseLawCitationResolutionCensusRuns,
  caseLawCitations,
  caseLawDecisions,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  candidateHoldersSql,
  policyCte,
  varcharArray,
} from "@/api/lib/case-law/citation-candidates";
import { CITATION_KIND } from "@/api/lib/case-law/citation-kind";
import {
  CITATION_AMBIGUITY_SHAPE,
  CITATION_AMBIGUITY_SHAPE_DISPOSITION,
  CITATION_AMBIGUITY_SHAPES,
  CITATION_CENSUS_ROW_KIND,
  CITATION_CENSUS_RULE_BUCKETS,
  CITATION_CENSUS_RUN_STATUS,
  CITATION_CENSUS_RUN_STATUSES,
  CITATION_CENSUS_UNATTRIBUTED_RULE,
  type CitationAmbiguityShape,
  type CitationCensusRuleBucket,
  type CitationCensusRunStatus,
} from "@/api/lib/case-law/citation-resolution-census-consts";
import {
  CITATION_CANDIDATE_SCAN_CAP,
  CITATION_RESOLUTION_RULE,
  CITATION_RESOLUTION_STATUS,
  CITATION_RESOLUTION_STATUSES,
  MERITS_DECISION_TYPES,
  PROCEDURAL_DECISION_TYPES,
  type CitationResolutionStatus,
} from "@/api/lib/case-law/citation-resolution-status";
import { brandPersistedCaseLawCitationResolutionCensusRunId } from "@/api/lib/safe-id-boundaries";
import { includes, isRecord } from "@/api/lib/type-guards";

/**
 * Rows one invocation reads: citations in the baseline walk, ambiguous keys
 * in the shape walk. The unit of progress that is persisted; a population
 * larger than this is covered across invocations, and the run's status says
 * which walk is under way.
 */
export const CITATION_CENSUS_KEY_BATCH = 2000;

/**
 * Upper bound on `(kind, bucket)` groups a report sums over. The corpus has
 * courts in the low thousands; reaching this means the grouping key itself
 * has broken, not that the corpus grew.
 */
export const CITATION_CENSUS_GROUP_BOUND = 50_000;

type CensusTx = {
  execute: (query: SQL) => Promise<unknown>;
};

export type CensusDb = <T>(fn: (tx: CensusTx) => Promise<T>) => Promise<T>;

const rows = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"];
  }
  return [];
};

const toCount = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const toText = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** Timestamps arrive as `Date` on the server driver and as text under pglite. */
const toDate = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
};

/**
 * The classifier, as one CASE over the bounded holder set. Order matters:
 * the scan bound is tested first because every later count is only known
 * to be complete below it, and court spread before type mix because a
 * cross-court key is a different file whatever its types say. A key whose
 * holders have all gone since the resolver last looked has no file at all,
 * so it is `other` rather than a shape a rule owns.
 */
const shapeCaseSql = (): SQL => sql`
  CASE
    WHEN m.n = 0 THEN ${CITATION_AMBIGUITY_SHAPE.OTHER}
    WHEN m.n >= ${CITATION_CANDIDATE_SCAN_CAP} THEN ${CITATION_AMBIGUITY_SHAPE.AT_CAP}
    WHEN m.courts > 1 THEN ${CITATION_AMBIGUITY_SHAPE.CROSS_COURT}
    WHEN m.untyped_n > 0 THEN ${CITATION_AMBIGUITY_SHAPE.UNTYPED}
    WHEN m.merits_n = 1 AND m.procedural_n = m.n - 1 THEN ${CITATION_AMBIGUITY_SHAPE.ONE_FILE_MERITS}
    WHEN m.merits_n = 0 AND m.procedural_n = m.n THEN ${CITATION_AMBIGUITY_SHAPE.ORDERS_ONLY}
    WHEN m.merits_n >= 2 AND m.procedural_n = m.n - m.merits_n THEN ${CITATION_AMBIGUITY_SHAPE.MERITS_ONLY}
    ELSE ${CITATION_AMBIGUITY_SHAPE.OTHER}
  END`;

export type CensusRunHeader = {
  id: SafeId<"caseLawCitationResolutionCensusRun">;
  status: CitationCensusRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  keysScanned: number;
};

/** Read back from the run table's own primary key. */
const createRunId = brandPersistedCaseLawCitationResolutionCensusRunId;

const isRunStatus = (value: unknown): value is CitationCensusRunStatus =>
  typeof value === "string" && includes(CITATION_CENSUS_RUN_STATUSES, value);

const readRunHeader = (row: unknown): CensusRunHeader | null => {
  if (!isRecord(row) || typeof row["id"] !== "string") {
    return null;
  }
  const status = row["status"];
  if (!isRunStatus(status)) {
    return null;
  }
  return {
    id: createRunId(row["id"]),
    status,
    startedAt: toDate(row["started_at"]) ?? new Date(0),
    finishedAt: toDate(row["finished_at"]),
    keysScanned: toCount(row["keys_scanned"]),
  };
};

/**
 * The run the next batch of work belongs to: the latest one if it is still
 * walking, else a fresh one. A fresh run's `started_at` is its cutoff.
 */
/**
 * The open run, locked for this transaction, or a new one when none is open.
 *
 * The lock is what makes two overlapping invocations safe: the second waits
 * on the row, then reads the status and cursors the first committed, so it
 * counts the next batch rather than the same one again. The partial unique
 * index over open runs is the other half: two invocations that both find no
 * open run cannot both insert one; the loser's transaction fails and the
 * scheduler simply invokes again.
 */
const lockOpenRun = async (tx: CensusTx): Promise<CensusRunHeader> => {
  const open: unknown = await tx.execute(sql`
    SELECT id::text, status, started_at, finished_at, keys_scanned
      FROM ${caseLawCitationResolutionCensusRuns}
     WHERE status <> ${CITATION_CENSUS_RUN_STATUS.COMPLETE}
     FOR UPDATE
  `);
  const openRun = readRunHeader(rows(open).at(0));
  if (openRun !== null) {
    return openRun;
  }

  const id = createSafeId<"caseLawCitationResolutionCensusRun">();
  const startedAt = new Date();
  // audit: skip — operational census, not a user action
  await tx.execute(sql`
    INSERT INTO ${caseLawCitationResolutionCensusRuns}
      (id, status, started_at, keys_scanned, cursor_key)
    VALUES (${id}::uuid, ${CITATION_CENSUS_RUN_STATUS.SCANNING_BASELINE}, ${startedAt}, 0, NULL)
  `);
  return {
    id,
    status: CITATION_CENSUS_RUN_STATUS.SCANNING_BASELINE,
    startedAt,
    finishedAt: null,
    keysScanned: 0,
  };
};

/**
 * The population one run counts: precedent citations that existed at the
 * cutoff and were not settled again after it. A row the resolver revisits
 * during the run is left to the next run, so a run's two walks never
 * disagree about a row between them. The cutoff is the run's own
 * `started_at`, read in the statement at the column's precision rather
 * than carried through a JS Date.
 */
const inPopulationSql = (
  runId: SafeId<"caseLawCitationResolutionCensusRun">,
): SQL => sql`
      c.kind = ${CITATION_KIND.PRECEDENT}
  AND c.created_at <= (
        SELECT started_at FROM ${caseLawCitationResolutionCensusRuns}
         WHERE id = ${runId}::uuid
      )
  AND (
        c.resolution_attempted_at IS NULL
     OR c.resolution_attempted_at <= (
          SELECT started_at FROM ${caseLawCitationResolutionCensusRuns}
           WHERE id = ${runId}::uuid
        )
      )`;

type BaselineCursor = {
  citingDecisionId: string;
  citationId: string;
} | null;

type BaselineBatch = {
  /** Citations this statement counted; zero means the walk reached the end. */
  citationsScanned: number;
  lastCursor: BaselineCursor;
};

type CountBaselineBatchOptions = {
  tx: CensusTx;
  runId: SafeId<"caseLawCitationResolutionCensusRun">;
  cursor: BaselineCursor;
  batch: number;
};

/**
 * Count the next batch of precedent citations after the cursor into this
 * run's status and rule rows. One statement: the batch on the resolver's
 * keyset axis, grouped by citing (country, court), upserted as increments.
 * A resolved row without a rule id is counted under the unattributed bucket
 * rather than dropped: those rows predate rule recording and are not
 * revisited, so dropping them would understate every rule count for good.
 */
const countBaselineBatch = async ({
  tx,
  runId,
  cursor,
  batch,
}: CountBaselineBatchOptions): Promise<BaselineBatch> => {
  // audit: skip — operational census, not a user action
  const result: unknown = await tx.execute(sql`
    WITH batch AS (
      SELECT c.id, c.citing_decision_id, c.resolution_status, c.resolution_rule_id
        FROM ${caseLawCitations} c
       WHERE ${inPopulationSql(runId)}
         ${
           cursor === null
             ? sql``
             : sql`AND (c.citing_decision_id, c.id) > (${cursor.citingDecisionId}::uuid, ${cursor.citationId}::uuid)`
         }
       ORDER BY c.citing_decision_id, c.id
       LIMIT ${batch}
    ),
    grouped AS (
      SELECT citing.country,
             citing.court,
             b.resolution_status AS status,
             CASE
               WHEN b.resolution_status = ${CITATION_RESOLUTION_STATUS.RESOLVED}
                 THEN coalesce(b.resolution_rule_id, ${CITATION_CENSUS_UNATTRIBUTED_RULE})
             END AS rule,
             count(*)::int AS citations
        FROM batch b
        JOIN ${caseLawDecisions} citing ON citing.id = b.citing_decision_id
       GROUP BY 1, 2, 3, 4
    ),
    status_written AS (
      INSERT INTO ${caseLawCitationResolutionCensus}
        (run_id, country, court, kind, bucket, keys, citations)
      SELECT ${runId}::uuid, g.country, g.court, ${CITATION_CENSUS_ROW_KIND.STATUS}, g.status, 0, sum(g.citations)::int
        FROM grouped g
       GROUP BY g.country, g.court, g.status
      ON CONFLICT (run_id, country, court, kind, bucket) DO UPDATE
        SET citations = ${caseLawCitationResolutionCensus}.citations + EXCLUDED.citations
      RETURNING 1
    ),
    rule_written AS (
      INSERT INTO ${caseLawCitationResolutionCensus}
        (run_id, country, court, kind, bucket, keys, citations)
      SELECT ${runId}::uuid, g.country, g.court, ${CITATION_CENSUS_ROW_KIND.RULE}, g.rule, 0, g.citations
        FROM grouped g
       WHERE g.rule IS NOT NULL
      ON CONFLICT (run_id, country, court, kind, bucket) DO UPDATE
        SET citations = ${caseLawCitationResolutionCensus}.citations + EXCLUDED.citations
      RETURNING 1
    )
    SELECT (SELECT count(*)::int FROM batch) AS citations_scanned,
           (SELECT citing_decision_id::text FROM batch
             ORDER BY citing_decision_id DESC, id DESC LIMIT 1) AS last_citing_decision_id,
           (SELECT id::text FROM batch
             ORDER BY citing_decision_id DESC, id DESC LIMIT 1) AS last_citation_id,
           (SELECT count(*)::int FROM status_written)
             + (SELECT count(*)::int FROM rule_written) AS groups_written
  `);
  const row = rows(result).at(0);
  if (!isRecord(row)) {
    return { citationsScanned: 0, lastCursor: null };
  }
  const citingDecisionId = toText(row["last_citing_decision_id"]);
  const citationId = toText(row["last_citation_id"]);
  return {
    citationsScanned: toCount(row["citations_scanned"]),
    lastCursor:
      citingDecisionId === null || citationId === null
        ? null
        : { citingDecisionId, citationId },
  };
};

type ShapeBatch = {
  /** Keys this statement classified; zero means the pool is exhausted. */
  keysScanned: number;
  /** The last key classified, to continue from. */
  lastKey: string | null;
};

type ClassifyBatchOptions = {
  tx: CensusTx;
  runId: SafeId<"caseLawCitationResolutionCensusRun">;
  cursorKey: string | null;
  keyBatch: number;
};

/**
 * Classify the next batch of ambiguous keys after `cursorKey` and fold their
 * citations into this run's shape rows.
 *
 * The shape is computed per citation, not per key, because the candidate set
 * is the citation's: the same holders the resolver reads for it, through the
 * same predicate, narrowed by the citing decision's jurisdiction and date.
 * Two citations of one key from different places can therefore land in
 * different shapes, and each lands in the one the resolver would act on.
 * One statement: the keys, the citations, their bounded candidate sets, the
 * shape per citation, and the citations per (citing country, citing court,
 * shape), upserted as increments so a run that stops between batches resumes
 * without double counting the batches it kept.
 */
const classifyBatch = async ({
  tx,
  runId,
  cursorKey,
  keyBatch,
}: ClassifyBatchOptions): Promise<ShapeBatch> => {
  // audit: skip — operational census, not a user action
  const result: unknown = await tx.execute(sql`
    WITH ${policyCte()},
    keys AS (
      SELECT DISTINCT c.citation_key AS key
        FROM ${caseLawCitations} c
       WHERE ${inPopulationSql(runId)}
         AND c.resolution_status = ${CITATION_RESOLUTION_STATUS.AMBIGUOUS}
         AND c.citation_key IS NOT NULL
         ${cursorKey === null ? sql`` : sql`AND c.citation_key > ${cursorKey}`}
       ORDER BY 1
       LIMIT ${keyBatch}
    ),
    shaped AS (
      SELECT k.key,
             citing.country,
             citing.court,
             ${shapeCaseSql()} AS shape
        FROM keys k
        JOIN ${caseLawCitations} c
          ON c.citation_key = k.key
         AND ${inPopulationSql(runId)}
         AND c.resolution_status = ${CITATION_RESOLUTION_STATUS.AMBIGUOUS}
        JOIN ${caseLawDecisions} citing ON citing.id = c.citing_decision_id
        LEFT JOIN policy pol ON pol.citing_country = citing.country
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS n,
                 count(DISTINCT h.court)::int AS courts,
                 count(*) FILTER (WHERE h.decision_type IS NULL)::int AS untyped_n,
                 count(*) FILTER (
                   WHERE lower(h.decision_type) = ANY (${varcharArray(MERITS_DECISION_TYPES)})
                 )::int AS merits_n,
                 count(*) FILTER (
                   WHERE lower(h.decision_type) = ANY (${varcharArray(PROCEDURAL_DECISION_TYPES)})
                 )::int AS procedural_n
            FROM (
              ${candidateHoldersSql({
                holder: sql.raw("d"),
                citationKey: sql.raw("k.key"),
                citingDecisionId: sql.raw("c.citing_decision_id"),
                citingDate: sql.raw("citing.decision_date"),
                resolvesTo: sql.raw(
                  "coalesce(pol.resolves_to, ARRAY[]::varchar[])",
                ),
              })}
            ) h
        ) m ON true
    ),
    grouped AS (
      SELECT s.country,
             s.court,
             s.shape,
             count(DISTINCT s.key)::int AS keys,
             count(*)::int AS citations
        FROM shaped s
       GROUP BY 1, 2, 3
    ),
    written AS (
      INSERT INTO ${caseLawCitationResolutionCensus}
        (run_id, country, court, kind, bucket, keys, citations)
      SELECT ${runId}::uuid, g.country, g.court, ${CITATION_CENSUS_ROW_KIND.SHAPE}, g.shape, g.keys, g.citations
        FROM grouped g
      ON CONFLICT (run_id, country, court, kind, bucket) DO UPDATE
        SET keys = ${caseLawCitationResolutionCensus}.keys + EXCLUDED.keys,
            citations = ${caseLawCitationResolutionCensus}.citations + EXCLUDED.citations
      RETURNING 1
    )
    SELECT (SELECT count(*)::int FROM keys) AS keys_scanned,
           (SELECT max(key) FROM keys) AS last_key,
           (SELECT count(*)::int FROM written) AS groups_written
  `);
  const row = rows(result).at(0);
  if (!isRecord(row)) {
    return { keysScanned: 0, lastKey: null };
  }
  return {
    keysScanned: toCount(row["keys_scanned"]),
    lastKey: toText(row["last_key"]),
  };
};

export type CensusRunOutcome = CensusRunHeader & {
  /** Rows this invocation read, whatever the run's total is. */
  keysScannedNow: number;
};

export type RunCitationResolutionCensusOptions = {
  db: CensusDb;
  /** Rows one invocation reads; default the batch constant. */
  keyBatch?: number;
  signal?: AbortSignal;
};

type RunCursors = {
  baseline: BaselineCursor;
  cursorKey: string | null;
};

const readCursors = async (
  tx: CensusTx,
  runId: SafeId<"caseLawCitationResolutionCensusRun">,
): Promise<RunCursors> => {
  const result: unknown = await tx.execute(sql`
    SELECT cursor_citing_decision_id::text, cursor_citation_id::text, cursor_key
      FROM ${caseLawCitationResolutionCensusRuns}
     WHERE id = ${runId}::uuid
  `);
  const row = rows(result).at(0);
  if (!isRecord(row)) {
    return { baseline: null, cursorKey: null };
  }
  const citingDecisionId = toText(row["cursor_citing_decision_id"]);
  const citationId = toText(row["cursor_citation_id"]);
  return {
    baseline:
      citingDecisionId === null || citationId === null
        ? null
        : { citingDecisionId, citationId },
    cursorKey: toText(row["cursor_key"]),
  };
};

/**
 * Advance the census by one batch.
 *
 * One invocation is one transaction that locks the open run, reads its
 * status and cursors under that lock, then counts, upserts and moves the
 * cursor together, so the persisted state is always a prefix of the
 * population that was counted exactly once, whoever else is invoking. A walking outcome asks the
 * caller to invoke again; the scheduler does that through a continuation
 * rather than a loop here, so one invocation never holds more than one
 * statement's worth of work. An empty baseline batch hands over to the
 * shape walk; an empty shape batch closes the run.
 */
export const runCitationResolutionCensus = async ({
  db,
  keyBatch = CITATION_CENSUS_KEY_BATCH,
  signal,
}: RunCitationResolutionCensusOptions): Promise<CensusRunOutcome> => {
  if (signal?.aborted) {
    return panic("SchedulerAborted");
  }
  return await db(async (tx) => {
    const run = await lockOpenRun(tx);
    const cursors = await readCursors(tx, run.id);
    switch (run.status) {
      case CITATION_CENSUS_RUN_STATUS.SCANNING_BASELINE: {
        const counted = await countBaselineBatch({
          tx,
          runId: run.id,
          cursor: cursors.baseline,
          batch: keyBatch,
        });
        if (counted.citationsScanned === 0 || counted.lastCursor === null) {
          // audit: skip — operational census, not a user action
          await tx.execute(sql`
            UPDATE ${caseLawCitationResolutionCensusRuns}
               SET status = ${CITATION_CENSUS_RUN_STATUS.SCANNING_SHAPES},
                   updated_at = now()
             WHERE id = ${run.id}::uuid
          `);
          return {
            ...run,
            status: CITATION_CENSUS_RUN_STATUS.SCANNING_SHAPES,
            keysScannedNow: 0,
          };
        }
        // audit: skip — operational census, not a user action
        await tx.execute(sql`
          UPDATE ${caseLawCitationResolutionCensusRuns}
             SET cursor_citing_decision_id = ${counted.lastCursor.citingDecisionId}::uuid,
                 cursor_citation_id = ${counted.lastCursor.citationId}::uuid,
                 updated_at = now()
           WHERE id = ${run.id}::uuid
        `);
        return { ...run, keysScannedNow: counted.citationsScanned };
      }
      case CITATION_CENSUS_RUN_STATUS.SCANNING_SHAPES: {
        const classified = await classifyBatch({
          tx,
          runId: run.id,
          cursorKey: cursors.cursorKey,
          keyBatch,
        });
        if (classified.keysScanned === 0) {
          // audit: skip — operational census, not a user action
          await tx.execute(sql`
            UPDATE ${caseLawCitationResolutionCensusRuns}
               SET status = ${CITATION_CENSUS_RUN_STATUS.COMPLETE},
                   finished_at = now(),
                   updated_at = now()
             WHERE id = ${run.id}::uuid
          `);
          return {
            ...run,
            status: CITATION_CENSUS_RUN_STATUS.COMPLETE,
            finishedAt: new Date(),
            keysScannedNow: 0,
          };
        }
        // audit: skip — operational census, not a user action
        await tx.execute(sql`
          UPDATE ${caseLawCitationResolutionCensusRuns}
             SET cursor_key = ${classified.lastKey},
                 keys_scanned = keys_scanned + ${classified.keysScanned},
                 updated_at = now()
           WHERE id = ${run.id}::uuid
        `);
        return {
          ...run,
          keysScanned: run.keysScanned + classified.keysScanned,
          keysScannedNow: classified.keysScanned,
        };
      }
      case CITATION_CENSUS_RUN_STATUS.COMPLETE:
        return panic("lockOpenRun returned a complete census run");
      default: {
        const exhaustive: never = run.status;
        return panic(`unknown census run status ${String(exhaustive)}`);
      }
    }
  });
};

/** One counted population in a snapshot. */
export type CensusGroup = {
  country: string;
  court: string;
  keys: number;
  citations: number;
};

export type CensusShapeGroup = CensusGroup & {
  shape: CitationAmbiguityShape;
  /** Change in citations against the previous complete run; null without one. */
  delta: number | null;
};

export type CitationResolutionCensusReport = {
  latest: CensusRunHeader | null;
  /** The most recent complete run before `latest`, the baseline for deltas. */
  previous: CensusRunHeader | null;
  byStatus: Record<CitationResolutionStatus, number>;
  byRule: Record<CitationCensusRuleBucket, number>;
  byShape: Record<CitationAmbiguityShape, number>;
  /**
   * The largest (country, court, shape) groups among shapes no rule owns,
   * by citations, capped at `limit`. The rows a new rule would start from.
   */
  unruled: CensusShapeGroup[];
};

// Listed by name so the record is total: a member added to any of the three
// lists without a zero here fails typecheck, the same way the resolver's
// per-rule counters do.
const zeroByStatus = (): Record<CitationResolutionStatus, number> => ({
  [CITATION_RESOLUTION_STATUS.PENDING]: 0,
  [CITATION_RESOLUTION_STATUS.RESOLVED]: 0,
  [CITATION_RESOLUTION_STATUS.UNMATCHED]: 0,
  [CITATION_RESOLUTION_STATUS.AMBIGUOUS]: 0,
});

const zeroByRule = (): Record<CitationCensusRuleBucket, number> => ({
  [CITATION_RESOLUTION_RULE.UNIQUE_KEY]: 0,
  [CITATION_RESOLUTION_RULE.TYPE_HINT]: 0,
  [CITATION_RESOLUTION_RULE.ONE_FILE_MERITS]: 0,
  [CITATION_CENSUS_UNATTRIBUTED_RULE]: 0,
});

const zeroByShape = (): Record<CitationAmbiguityShape, number> => ({
  [CITATION_AMBIGUITY_SHAPE.AT_CAP]: 0,
  [CITATION_AMBIGUITY_SHAPE.CROSS_COURT]: 0,
  [CITATION_AMBIGUITY_SHAPE.UNTYPED]: 0,
  [CITATION_AMBIGUITY_SHAPE.ONE_FILE_MERITS]: 0,
  [CITATION_AMBIGUITY_SHAPE.ORDERS_ONLY]: 0,
  [CITATION_AMBIGUITY_SHAPE.MERITS_ONLY]: 0,
  [CITATION_AMBIGUITY_SHAPE.OTHER]: 0,
});

const isShape = (value: unknown): value is CitationAmbiguityShape =>
  typeof value === "string" && includes(CITATION_AMBIGUITY_SHAPES, value);

const isStatus = (value: unknown): value is CitationResolutionStatus =>
  typeof value === "string" && includes(CITATION_RESOLUTION_STATUSES, value);

const isRule = (value: unknown): value is CitationCensusRuleBucket =>
  typeof value === "string" && includes(CITATION_CENSUS_RULE_BUCKETS, value);

export type ReadCitationResolutionCensusOptions = {
  db: CensusDb;
  /** How many unruled groups to return. */
  limit: number;
};

/**
 * The latest snapshot, with the previous complete one as a baseline.
 *
 * Totals are summed over every (country, court) group of the latest run;
 * the unruled list is the top groups by citations, each with its delta
 * against the same group in the baseline when the latest run is complete.
 * A scanning run has no deltas: a partial count compared with a full one
 * would read as a drop that never happened.
 */
export const readCitationResolutionCensus = async ({
  db,
  limit,
}: ReadCitationResolutionCensusOptions): Promise<CitationResolutionCensusReport> =>
  await db(async (tx) => {
    const runsResult: unknown = await tx.execute(sql`
      SELECT id::text, status, started_at, finished_at, keys_scanned
        FROM ${caseLawCitationResolutionCensusRuns}
       ORDER BY started_at DESC
       LIMIT 2
    `);
    const runRows = rows(runsResult);
    const latest = readRunHeader(runRows.at(0));
    const empty: CitationResolutionCensusReport = {
      latest: null,
      previous: null,
      byStatus: zeroByStatus(),
      byRule: zeroByRule(),
      byShape: zeroByShape(),
      unruled: [],
    };
    if (latest === null) {
      return empty;
    }

    const previousResult: unknown = await tx.execute(sql`
      SELECT id::text, status, started_at, finished_at, keys_scanned
        FROM ${caseLawCitationResolutionCensusRuns}
       WHERE status = ${CITATION_CENSUS_RUN_STATUS.COMPLETE}
         AND id <> ${latest.id}::uuid
       ORDER BY started_at DESC
       LIMIT 1
    `);
    const previous = readRunHeader(rows(previousResult).at(0));

    const totalsResult: unknown = await tx.execute(sql`
      SELECT kind, bucket, sum(citations)::int AS citations
        FROM ${caseLawCitationResolutionCensus}
       WHERE run_id = ${latest.id}::uuid
       GROUP BY 1, 2
       LIMIT ${CITATION_CENSUS_GROUP_BOUND}
    `);
    const report: CitationResolutionCensusReport = {
      ...empty,
      latest,
      previous,
    };
    for (const row of rows(totalsResult)) {
      if (!isRecord(row)) {
        continue;
      }
      const citations = toCount(row["citations"]);
      const bucket = row["bucket"];
      switch (row["kind"]) {
        case CITATION_CENSUS_ROW_KIND.STATUS:
          if (isStatus(bucket)) {
            report.byStatus[bucket] += citations;
          }
          break;
        case CITATION_CENSUS_ROW_KIND.RULE:
          if (isRule(bucket)) {
            report.byRule[bucket] += citations;
          }
          break;
        case CITATION_CENSUS_ROW_KIND.SHAPE:
          if (isShape(bucket)) {
            report.byShape[bucket] += citations;
          }
          break;
        default:
          break;
      }
    }

    const unruledShapes = CITATION_AMBIGUITY_SHAPES.filter(
      (shape) => CITATION_AMBIGUITY_SHAPE_DISPOSITION[shape].kind === "unruled",
    );
    const baseline =
      latest.status === CITATION_CENSUS_RUN_STATUS.COMPLETE ? previous : null;
    const unruledResult: unknown = await tx.execute(sql`
      SELECT latest.country,
             latest.court,
             latest.bucket AS shape,
             latest.keys,
             latest.citations,
             ${
               baseline === null
                 ? sql`NULL::int`
                 : sql`latest.citations - coalesce(prior.citations, 0)`
             } AS delta
        FROM ${caseLawCitationResolutionCensus} latest
        ${
          baseline === null
            ? sql``
            : sql`LEFT JOIN ${caseLawCitationResolutionCensus} prior
                 ON prior.run_id = ${baseline.id}::uuid
                AND prior.country = latest.country
                AND prior.court = latest.court
                AND prior.kind = latest.kind
                AND prior.bucket = latest.bucket`
        }
       WHERE latest.run_id = ${latest.id}::uuid
         AND latest.kind = ${CITATION_CENSUS_ROW_KIND.SHAPE}
         AND latest.bucket = ANY (${varcharArray(unruledShapes)})
       ORDER BY latest.citations DESC, latest.country, latest.court
       LIMIT ${limit}
    `);
    for (const row of rows(unruledResult)) {
      if (!isRecord(row) || !isShape(row["shape"])) {
        continue;
      }
      const delta = row["delta"];
      report.unruled.push({
        country: toText(row["country"]) ?? "",
        court: toText(row["court"]) ?? "",
        shape: row["shape"],
        keys: toCount(row["keys"]),
        citations: toCount(row["citations"]),
        delta: delta === null || delta === undefined ? null : toCount(delta),
      });
    }
    return report;
  });
