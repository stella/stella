/**
 * What a corpus family would lose if readers moved from the generation that
 * serves it to another one, read exactly from PostgreSQL.
 *
 * A flip is safe for a decision when the candidate generation shows it at
 * least as current as the serving one does. "Shows" is what a reader is given:
 * an upsert is wanted, the state names a copy in the index its route wants,
 * and that copy's documents are in the engine. The serving side counts a copy
 * whose delete may be in flight as shown and the candidate side does not, so
 * every doubt counts against the flip.
 *
 * A decision is a regression when the serving generation shows it at applied
 * epoch `e`, applied no later than the watermark, and the candidate generation
 * does not show it at an epoch of `e` or later:
 *
 * - `not_shown`: the candidate has a state for it but no copy readers would be
 *   given;
 * - `stale`: the candidate shows an older copy than the serving generation;
 * - `no_state`: the candidate has no state for it at all (the coverage walk).
 *
 * The watermark exempts what the serving generation itself applied after it:
 * both generations take the same change, and the candidate needs its own
 * commit window to show it. An erasure needs no rule of its own: every reader
 * hides a decision as soon as its desired action is an erasure, in either
 * generation.
 *
 * Only candidate states that are not converged can be regressions, so the read
 * walks those alone, through the partial indexes that hold them: work pending,
 * blocked, a named copy proven gone, a named copy whose delete may be in
 * flight. That set is complete under two invariants, both held by the
 * desired-state writer:
 *
 * - every active generation of a family takes a canonical change in the same
 *   transaction and at the same desired epoch, so a converged candidate state
 *   is never older than the serving generation's applied copy;
 * - whether a decision is erased does not depend on the generation, except
 *   through a jurisdiction-serving pointer (`vacatedFrom`). The read refuses
 *   while a pointer exists.
 *
 * A candidate state that is missing altogether is found by the coverage walk,
 * page by page over the serving generation's applied copies. Once a walk has
 * passed an entity it stays covered: a new decision gets a state in every
 * active generation in the transaction that creates it, and only a rebuild
 * deletes states.
 */
import { panic, Result, TaggedError } from "better-result";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { declareFingerprintFields } from "@stll/errors";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { executedRows } from "@/api/lib/db/executed-rows";
import { readBounded } from "@/api/lib/db/read-bounded";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import { readJurisdictionServingGenerationsTx } from "@/api/lib/legal-search/corpus-index-jurisdiction-serving-store";
import {
  CORPUS_INDEX_PROJECTION_SERVING,
  corpusIndexProjectionIsAbsent,
  corpusIndexProjectionIsBlocked,
  corpusIndexProjectionNeedsWork,
  corpusIndexProjectionRevisionDeleteIsUnproven,
} from "@/api/lib/legal-search/corpus-index-projection-sql";
import { isRecord } from "@/api/lib/type-guards";

/** The two generations a flip moves readers between. */
export type CorpusIndexFlipPair = {
  family: CorpusFamily;
  /** The generation readers are served from now. */
  serving: string;
  /** The generation the flip would move them to. */
  candidate: string;
};

const CORPUS_INDEX_FLIP_REGRESSION_KINDS = ["not_shown", "stale"] as const;
type CorpusIndexFlipRegressionKind =
  (typeof CORPUS_INDEX_FLIP_REGRESSION_KINDS)[number];

/**
 * Rows each candidate walk reads at most. At a flip the candidate's
 * unconverged work is the last few commit windows of inflow; past this many in
 * one walk the read reports a lower bound, and a lower bound never proves a
 * flip.
 */
export const CORPUS_INDEX_FLIP_WALK_CAP = 10_000;

/** Regressions a reading lists by name; the counts cover all of them. */
const CORPUS_INDEX_FLIP_SAMPLE_MAX = 50;

/** Serving copies one coverage page reads at most. */
const CORPUS_INDEX_FLIP_COVERAGE_PAGE_MAX = 5000;

export class CorpusIndexFlipPairRefusedError extends TaggedError(
  "CorpusIndexFlipPairRefusedError",
)<{
  message: string;
  reason:
    | "same_generation"
    | "generation_not_active"
    | "jurisdiction_serving_pointer";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

export class CorpusIndexFlipParityReadError extends TaggedError(
  "CorpusIndexFlipParityReadError",
)<{
  message: string;
  cause: unknown;
}> {}

type CorpusIndexFlipParityError =
  CorpusIndexFlipPairRefusedError | CorpusIndexFlipParityReadError;

const states = corpusIndexProjectionStates;
const intents = corpusIndexProjectionIntents;
const candidateState = alias(states, "candidate_state");
const servingState = alias(states, "serving_state");

/** The copy columns of the revision a state names, as its lateral lookup returns them. */
const namedRevisionCopy = (
  name: "candidate_revision" | "serving_revision",
) => ({
  status: sql.raw(`${name}.status`),
  cleanupAttempts: sql.raw(`${name}.cleanup_attempts`),
});
const candidateRevision = namedRevisionCopy("candidate_revision");
const servingRevision = namedRevisionCopy("serving_revision");

/**
 * One generation's state of a walked entity, read by the states' primary key.
 * As the revision lookup below, a lateral read with a `LIMIT`, so every walked
 * entity costs one probe and the plan never reads a generation's states whole
 * to join them. It returns the columns the classification reads, under their
 * own names, so the aliased columns resolve against it.
 */
const stateLookup = (
  name: "candidate_state" | "serving_state",
  family: CorpusFamily,
  generation: string,
): SQL => sql`JOIN LATERAL (
        SELECT ${states.desiredAction}, ${states.desiredIndexId},
          ${states.appliedAction}, ${states.appliedEpoch},
          ${states.appliedRevision}, ${states.appliedRevisionSettled},
          ${states.appliedIndexId}, ${states.appliedAt}
        FROM ${states}
        WHERE ${generationOf(states, family, generation)}
          AND ${states.entityId} = walked.entity_id
        LIMIT 1
      ) ${sql.raw(name)} ON true`;

/**
 * The revision a state names, read by the revisions' primary key. A lateral
 * lookup whose `LIMIT` keeps PostgreSQL from pulling it up into a join, so
 * the plan starts from the states it was handed and never walks revisions by
 * their status.
 */
const namedRevisionLookup = (
  state: typeof candidateState | typeof servingState,
  name: "candidate_revision" | "serving_revision",
): SQL => sql`LEFT JOIN LATERAL (
        SELECT ${intents.status} AS status,
          ${intents.cleanupAttempts} AS cleanup_attempts
        FROM ${intents}
        WHERE ${intents.id} = ${state.appliedRevision}
        LIMIT 1
      ) ${sql.raw(name)} ON true`;

const MICROSECONDS_PER_NANOSECOND = 1000n;

/**
 * Instants travel as epoch microseconds, PostgreSQL's own precision, so the
 * watermark compares exactly with the applied instants it is read against.
 */
const epochMicros = (instant: SQL): SQL =>
  sql`(extract(epoch FROM ${instant}) * 1000000)::bigint`;

const instantFromMicros = (micros: string): Temporal.Instant =>
  Temporal.Instant.fromEpochNanoseconds(
    BigInt(micros) * MICROSECONDS_PER_NANOSECOND,
  );

/** An instant as a full-precision text token for a `::timestamptz` cast. */
const microsecondToken = (instant: Temporal.Instant): string =>
  instant.toString({ smallestUnit: "microsecond" });

/**
 * The serving side's "shows": an upsert is wanted, the named copy sits in the
 * index the route wants, and its documents are whole or a delete of them may
 * be in flight.
 */
const servingShows = sql`(
  ${servingState.appliedIndexId} = ${servingState.desiredIndexId}
  AND (
    ${CORPUS_INDEX_PROJECTION_SERVING.served({ state: servingState, revision: servingRevision })}
    OR ${CORPUS_INDEX_PROJECTION_SERVING.at_risk({ state: servingState, revision: servingRevision })}
  )
)`;

/** The candidate side's "shows": as the serving side, but only a whole copy. */
const candidateShows = sql`(
  ${candidateState.appliedIndexId} = ${candidateState.desiredIndexId}
  AND ${CORPUS_INDEX_PROJECTION_SERVING.served({ state: candidateState, revision: candidateRevision })}
)`;

const generationOf = (
  table: typeof states | typeof intents,
  family: CorpusFamily,
  generation: string,
): SQL =>
  sql`${table.family} = ${family} AND ${table.generation} = ${generation}`;

/**
 * The candidate walks and their classification, one statement. Each walk
 * reads its partial index in the index's own order up to one row past the
 * cap, so `exact` is decided per walk; the classification probes both
 * generations by primary key for each walked entity.
 */
export const corpusIndexFlipRegressionQuery = (
  pair: CorpusIndexFlipPair,
  watermark: Temporal.Instant,
): SQL => {
  const { family, serving, candidate } = pair;
  const walkLimit = CORPUS_INDEX_FLIP_WALK_CAP + 1;
  return sql`
    WITH pending_walk AS MATERIALIZED (
      SELECT ${states.entityId} AS entity_id
      FROM ${states}
      WHERE ${generationOf(states, family, candidate)}
        AND ${corpusIndexProjectionNeedsWork(states)}
      ORDER BY coalesce(${states.retryNotBefore}, ${states.updatedAt}), ${states.entityId}
      LIMIT ${walkLimit}
    ),
    blocked_walk AS MATERIALIZED (
      SELECT ${states.entityId} AS entity_id
      FROM ${states}
      WHERE ${generationOf(states, family, candidate)}
        AND ${corpusIndexProjectionIsBlocked(states.workStatus)}
      ORDER BY ${states.entityId}
      LIMIT ${walkLimit}
    ),
    absent_walk AS MATERIALIZED (
      SELECT ${states.entityId} AS entity_id
      FROM ${states}
      WHERE ${generationOf(states, family, candidate)}
        AND ${corpusIndexProjectionIsAbsent(states)}
      ORDER BY ${states.entityId}
      LIMIT ${walkLimit}
    ),
    at_risk_walk AS MATERIALIZED (
      SELECT ${intents.entityId} AS entity_id
      FROM ${intents}
      WHERE ${generationOf(intents, family, candidate)}
        AND ${corpusIndexProjectionRevisionDeleteIsUnproven(intents)}
      ORDER BY coalesce(${intents.cleanupStartedAt}, ${intents.updatedAt}), ${intents.id}
      LIMIT ${walkLimit}
    ),
    walked AS (
      SELECT entity_id FROM pending_walk
      UNION SELECT entity_id FROM blocked_walk
      UNION SELECT entity_id FROM absent_walk
      UNION SELECT entity_id FROM at_risk_walk
    ),
    regressions AS (
      SELECT walked.entity_id::text AS entity_id,
        coalesce(${candidateState.desiredIndexId}, ${candidateState.appliedIndexId}) AS route,
        CASE WHEN ${candidateShows} THEN 'stale' ELSE 'not_shown' END AS kind,
        ${servingState.appliedEpoch}::text AS serving_epoch,
        ${candidateState.appliedEpoch}::text AS candidate_epoch,
        ${epochMicros(sql`${servingState.appliedAt}`)}::text AS serving_applied_us
      FROM walked
      ${stateLookup("candidate_state", family, candidate)}
      ${namedRevisionLookup(candidateState, "candidate_revision")}
      ${stateLookup("serving_state", family, serving)}
      ${namedRevisionLookup(servingState, "serving_revision")}
      WHERE ${servingShows}
        AND ${servingState.appliedAt} <= ${microsecondToken(watermark)}::timestamptz
        AND NOT (
          ${candidateShows}
          AND ${candidateState.appliedEpoch} >= ${servingState.appliedEpoch}
        )
    )
    SELECT
      (SELECT count(*) FROM pending_walk)::int AS pending_walked,
      (SELECT count(*) FROM blocked_walk)::int AS blocked_walked,
      (SELECT count(*) FROM absent_walk)::int AS absent_walked,
      (SELECT count(*) FROM at_risk_walk)::int AS at_risk_walked,
      coalesce((
        SELECT json_agg(json_build_object(
          'route', per_route.route,
          'kind', per_route.kind,
          'count', per_route.count
        ) ORDER BY per_route.route, per_route.kind)
        FROM (
          SELECT route, kind, count(*)::int AS count
          FROM regressions
          GROUP BY route, kind
        ) AS per_route
      ), '[]'::json) AS by_route,
      coalesce((
        SELECT json_agg(json_build_object(
          'entity_id', sampled.entity_id,
          'route', sampled.route,
          'kind', sampled.kind,
          'serving_epoch', sampled.serving_epoch,
          'candidate_epoch', sampled.candidate_epoch,
          'serving_applied_us', sampled.serving_applied_us
        ) ORDER BY sampled.entity_id)
        FROM (
          SELECT * FROM regressions
          ORDER BY entity_id
          LIMIT ${CORPUS_INDEX_FLIP_SAMPLE_MAX}
        ) AS sampled
      ), '[]'::json) AS sample`;
};

type CorpusIndexFlipRegression = {
  entityId: string;
  /** The candidate index the decision belongs to; null when it wants none. */
  route: string | null;
  kind: CorpusIndexFlipRegressionKind;
  servingEpoch: bigint;
  /** The candidate's applied epoch; null when it applied nothing. */
  candidateEpoch: bigint | null;
  servingAppliedAt: Temporal.Instant;
};

type CorpusIndexFlipRouteRegressions = {
  route: string | null;
  kind: CorpusIndexFlipRegressionKind;
  count: number;
};

/**
 * `exact`: every walk reached its end, so the counts are every regression of
 * the pair and a route not listed has none. `at_least`: a walk stopped at the
 * cap, so the counts are lower bounds and prove nothing about readiness.
 */
export type CorpusIndexFlipRegressionReading = {
  type: "exact" | "at_least";
  walked: {
    pending: number;
    blocked: number;
    absent: number;
    atRisk: number;
  };
  byRoute: readonly CorpusIndexFlipRouteRegressions[];
  /** The first regressions in entity order. */
  sample: readonly CorpusIndexFlipRegression[];
};

const requiredText = (row: unknown, key: string): string => {
  if (!isRecord(row) || typeof row[key] !== "string") {
    return panic(`Malformed flip parity row: ${key}`);
  }
  return row[key];
};

const nullableText = (row: unknown, key: string): string | null => {
  if (!isRecord(row)) {
    return panic(`Malformed flip parity row: ${key}`);
  }
  const value = row[key];
  if (value === null) {
    return null;
  }
  return typeof value === "string"
    ? value
    : panic(`Malformed flip parity row: ${key}`);
};

const requiredCount = (row: unknown, key: string): number => {
  if (!isRecord(row)) {
    return panic(`Malformed flip parity row: ${key}`);
  }
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : panic(`Malformed flip parity row: ${key}`);
};

const requiredArray = (row: unknown, key: string): unknown[] => {
  if (!isRecord(row)) {
    return panic(`Malformed flip parity row: ${key}`);
  }
  const value = row[key];
  return Array.isArray(value)
    ? value
    : panic(`Malformed flip parity row: ${key}`);
};

const regressionKind = (value: string): CorpusIndexFlipRegressionKind =>
  CORPUS_INDEX_FLIP_REGRESSION_KINDS.find((kind) => kind === value) ??
  panic(`Unknown flip regression kind: ${value}`);

const readError = (pair: CorpusIndexFlipPair, cause: unknown) =>
  new CorpusIndexFlipParityReadError({
    message: `Could not read the flip parity of ${pair.family}: ${pair.serving} -> ${pair.candidate}`,
    cause,
  });

const readRows = async (
  tx: Transaction,
  query: SQL,
  pair: CorpusIndexFlipPair,
): Promise<Result<unknown[], CorpusIndexFlipParityReadError>> =>
  await Result.tryPromise({
    try: async () => executedRows(await tx.execute(query)),
    catch: (cause) => readError(pair, cause),
  });

/** Generation statuses whose projection takes every canonical change. */
const ACTIVE_GENERATION_STATUSES = ["building", "serving"] as const;

/**
 * Refuse a pair the read cannot answer exactly: one generation twice, a
 * generation that no longer takes every change, or a family whose erasures
 * depend on the generation through a jurisdiction-serving pointer.
 */
const requireComparablePair = async (
  tx: Transaction,
  pair: CorpusIndexFlipPair,
): Promise<Result<void, CorpusIndexFlipParityError>> => {
  if (pair.serving === pair.candidate) {
    return Result.err(
      new CorpusIndexFlipPairRefusedError({
        message: `A flip compares two generations; both are ${pair.serving}`,
        reason: "same_generation",
      }),
    );
  }
  const pairGenerations = [pair.serving, pair.candidate];
  const registered = await Result.tryPromise({
    try: async () =>
      await readBounded(
        tx
          .select({
            generation: corpusIndexGenerations.generation,
            status: corpusIndexGenerations.status,
          })
          .from(corpusIndexGenerations)
          .where(
            and(
              eq(corpusIndexGenerations.family, pair.family),
              inArray(corpusIndexGenerations.generation, pairGenerations),
            ),
          ),
        pairGenerations.length,
      ),
    catch: (cause) => readError(pair, cause),
  });
  if (Result.isError(registered)) {
    return registered;
  }
  if (registered.value.type === "overflow") {
    // The registry's key is (family, generation): two names, two rows at most.
    return panic("A generation pair matched more registry rows than names");
  }
  const rows = registered.value.rows;
  for (const generation of pairGenerations) {
    const row = rows.find((entry) => entry.generation === generation);
    if (
      row === undefined ||
      !ACTIVE_GENERATION_STATUSES.some((status) => status === row.status)
    ) {
      return Result.err(
        new CorpusIndexFlipPairRefusedError({
          message: `${pair.family}/${generation} is not an active generation (${row?.status ?? "not registered"}); only building and serving generations take every change`,
          reason: "generation_not_active",
        }),
      );
    }
  }
  const pointers = await Result.tryPromise({
    try: async () =>
      await readJurisdictionServingGenerationsTx(tx, pair.family),
    catch: (cause) => readError(pair, cause),
  });
  if (Result.isError(pointers)) {
    return pointers;
  }
  const [pointer] = pointers.value.keys();
  if (pointer !== undefined) {
    return Result.err(
      new CorpusIndexFlipPairRefusedError({
        message: `${pointer} is served through a jurisdiction-serving pointer, which makes its erasures depend on the generation; a whole-family flip is not compared while one exists`,
        reason: "jurisdiction_serving_pointer",
      }),
    );
  }
  return Result.ok();
};

/**
 * Every decision the flip would lose or regress, among the candidate states
 * that have not converged. Exact when no walk reached its cap; recomputed
 * under the exclusive mutation fence it is exact at that instant.
 */
export const readCorpusIndexFlipRegressionsTx = async (
  tx: Transaction,
  {
    pair,
    watermark,
  }: { pair: CorpusIndexFlipPair; watermark: Temporal.Instant },
): Promise<
  Result<CorpusIndexFlipRegressionReading, CorpusIndexFlipParityError>
> => {
  const comparable = await requireComparablePair(tx, pair);
  if (Result.isError(comparable)) {
    return comparable;
  }
  const rows = await readRows(
    tx,
    corpusIndexFlipRegressionQuery(pair, watermark),
    pair,
  );
  if (Result.isError(rows)) {
    return rows;
  }
  const row = rows.value.at(0);
  const walked = {
    pending: requiredCount(row, "pending_walked"),
    blocked: requiredCount(row, "blocked_walked"),
    absent: requiredCount(row, "absent_walked"),
    atRisk: requiredCount(row, "at_risk_walked"),
  };
  const stopped = Object.values(walked).some(
    (count) => count > CORPUS_INDEX_FLIP_WALK_CAP,
  );
  return Result.ok({
    type: stopped ? "at_least" : "exact",
    walked,
    byRoute: requiredArray(row, "by_route").map((entry) => ({
      route: nullableText(entry, "route"),
      kind: regressionKind(requiredText(entry, "kind")),
      count: requiredCount(entry, "count"),
    })),
    sample: requiredArray(row, "sample").map((entry) => {
      const candidateEpoch = nullableText(entry, "candidate_epoch");
      return {
        entityId: requiredText(entry, "entity_id"),
        route: nullableText(entry, "route"),
        kind: regressionKind(requiredText(entry, "kind")),
        servingEpoch: BigInt(requiredText(entry, "serving_epoch")),
        candidateEpoch: candidateEpoch === null ? null : BigInt(candidateEpoch),
        servingAppliedAt: instantFromMicros(
          requiredText(entry, "serving_applied_us"),
        ),
      };
    }),
  });
};

/**
 * One page of the coverage walk: the serving generation's applied copies in
 * one index, in entity order, read through its applied-census index, and among
 * them the ones it shows that the candidate has no state for.
 */
export const corpusIndexFlipCoveragePageQuery = (
  pair: CorpusIndexFlipPair,
  {
    servingIndexId,
    after,
    limit,
  }: { servingIndexId: string; after: string | null; limit: number },
): SQL => {
  const { family, serving, candidate } = pair;
  return sql`
    WITH walked AS MATERIALIZED (
      SELECT ${states.entityId} AS entity_id
      FROM ${states}
      WHERE ${generationOf(states, family, serving)}
        AND ${states.appliedIndexId} = ${servingIndexId}
        -- The applied shape check makes these two conjuncts one condition;
        -- spelling both is what the applied-census partial index requires.
        AND ${states.appliedAction} = 'upsert'
        AND ${states.appliedRevision} IS NOT NULL${
          after === null
            ? sql``
            : sql`
        AND ${states.entityId} > ${after}::uuid`
        }
      ORDER BY ${states.entityId}
      LIMIT ${limit}
    ),
    missing AS (
      SELECT walked.entity_id::text AS entity_id,
        ${servingState.appliedEpoch}::text AS serving_epoch,
        ${epochMicros(sql`${servingState.appliedAt}`)}::text AS serving_applied_us
      FROM walked
      ${stateLookup("serving_state", family, serving)}
      ${namedRevisionLookup(servingState, "serving_revision")}
      -- One primary-key probe per copy: as an anti-join the planner may
      -- read the candidate's states whole.
      LEFT JOIN LATERAL (
        SELECT true AS present
        FROM ${states}
        WHERE ${generationOf(states, family, candidate)}
          AND ${states.entityId} = walked.entity_id
        LIMIT 1
      ) candidate_presence ON true
      WHERE ${servingShows}
        AND candidate_presence.present IS NULL
    )
    SELECT
      (SELECT count(*) FROM walked)::int AS walked,
      (
        SELECT walked.entity_id::text FROM walked
        ORDER BY walked.entity_id DESC
        LIMIT 1
      ) AS last_entity_id,
      coalesce((
        SELECT json_agg(json_build_object(
          'entity_id', missing.entity_id,
          'serving_epoch', missing.serving_epoch,
          'serving_applied_us', missing.serving_applied_us
        ) ORDER BY missing.entity_id)
        FROM missing
      ), '[]'::json) AS missing`;
};

type CorpusIndexFlipMissingState = {
  entityId: string;
  servingEpoch: bigint;
  servingAppliedAt: Temporal.Instant;
};

type CorpusIndexFlipCoveragePage = {
  /** Serving copies this page read. */
  walked: number;
  /** Decisions the serving generation shows that the candidate has no state for. */
  missing: readonly CorpusIndexFlipMissingState[];
  /** Where the next page starts; null once the index is exhausted. */
  next: string | null;
};

export const readCorpusIndexFlipCoveragePageTx = async (
  tx: Transaction,
  {
    pair,
    servingIndexId,
    after,
    limit,
  }: {
    pair: CorpusIndexFlipPair;
    servingIndexId: string;
    after: string | null;
    limit: number;
  },
): Promise<Result<CorpusIndexFlipCoveragePage, CorpusIndexFlipParityError>> => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CORPUS_INDEX_FLIP_COVERAGE_PAGE_MAX
  ) {
    return panic(`Invalid flip coverage page size: ${limit}`);
  }
  const comparable = await requireComparablePair(tx, pair);
  if (Result.isError(comparable)) {
    return comparable;
  }
  const rows = await readRows(
    tx,
    corpusIndexFlipCoveragePageQuery(pair, { servingIndexId, after, limit }),
    pair,
  );
  if (Result.isError(rows)) {
    return rows;
  }
  const row = rows.value.at(0);
  const walked = requiredCount(row, "walked");
  return Result.ok({
    walked,
    missing: requiredArray(row, "missing").map((entry) => ({
      entityId: requiredText(entry, "entity_id"),
      servingEpoch: BigInt(requiredText(entry, "serving_epoch")),
      servingAppliedAt: instantFromMicros(
        requiredText(entry, "serving_applied_us"),
      ),
    })),
    next: walked < limit ? null : nullableText(row, "last_entity_id"),
  });
};

/**
 * The watermark `exemptMinutes` before the database clock: serving applies
 * after it are the candidate's expected lag, not a regression.
 */
export const readCorpusIndexFlipWatermarkTx = async (
  tx: Transaction,
  exemptMinutes: number,
): Promise<Temporal.Instant> => {
  if (!Number.isSafeInteger(exemptMinutes) || exemptMinutes < 0) {
    return panic(`Invalid flip watermark: ${exemptMinutes} minutes`);
  }
  const rows = executedRows(
    await tx.execute(
      sql`SELECT ${epochMicros(sql`clock_timestamp()`)}::text AS now_us`,
    ),
  );
  return instantFromMicros(requiredText(rows.at(0), "now_us")).subtract({
    minutes: exemptMinutes,
  });
};
