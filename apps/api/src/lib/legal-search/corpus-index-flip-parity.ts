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
 * epoch `e` and the candidate generation does not show it at an epoch of `e`
 * or later:
 *
 * - `not_shown`: the candidate has a state for it but no copy readers would be
 *   given;
 * - `stale`: the candidate shows an older copy than the serving generation;
 * - missing: the candidate has no state for it at all (the coverage walk).
 *
 * Only what the candidate will converge on by itself is exempt, and only when
 * the change is younger than the watermark: a `stale` decision whose newer
 * change the candidate was handed after the watermark, and a `not_shown`
 * decision that did not exist before it (its serving state was created after
 * the watermark). Either way the candidate's state must be ordinary pending
 * work: a blocked state, a retrying or repairing one, a copy proven gone or a
 * delete in flight is never exempt, whenever the serving generation last
 * applied the decision. An erasure needs no rule of its own: every reader
 * hides a decision as soon as its desired action is an erasure, in either
 * generation.
 *
 * Only candidate states that are not converged can be regressions, so the read
 * walks those alone, through the partial indexes that hold them: work pending,
 * blocked, a named copy proven gone, a named copy whose delete may be in
 * flight. That set is complete under two invariants:
 *
 * - every generation's desired epoch is a value of the one per-entity
 *   canonical projection epoch: a generation's epoch may trail the canonical
 *   one while its content is current, never lead it, and no generation numbers
 *   epochs of its own. So a converged candidate holds current content, and
 *   comparing two generations' applied epochs compares two readings of one
 *   counter (`corpus-index-projection-desired-state.db.test.ts` pins it);
 * - whether a decision is erased does not depend on the generation, except
 *   through a jurisdiction-serving pointer (`vacatedFrom`) or a partial
 *   generation's scope. The read refuses both.
 *
 * Order matters. A candidate state that is missing altogether is found by the
 * coverage walk, page by page over every serving state that wants an upsert,
 * shown yet or not; the regression statement runs after the walk has ended.
 * Nothing deletes a projection state outside a rebuild, so a state the walk
 * saw is still there for the regression statement to classify, a candidate
 * state seeded after its page was read is reported as missing, and a serving
 * state applied after its page was read is still one the walk counted, all of
 * which only overstates. In the other order a decision seeded between the two
 * reads would be reported by neither.
 * `readCorpusIndexFlipParity` owns that order; it is the only way to a verdict.
 */
import { panic, Result, TaggedError } from "better-result";
import { and, eq, or, type SQL, sql } from "drizzle-orm";
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
  corpusIndexManifestIsPartial,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  CORPUS_INDEX_PROJECTION_SERVING,
  corpusIndexProjectionIsAbsent,
  corpusIndexProjectionIsBlocked,
  corpusIndexProjectionNeedsWork,
  corpusIndexProjectionRevisionDeleteIsUnproven,
} from "@/api/lib/legal-search/corpus-index-projection-sql";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";
import { isRecord } from "@/api/lib/type-guards";

/** The two generations a flip moves readers between. */
type CorpusIndexFlipPair = {
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

/** Decisions a reading lists by name; the counts cover all of them. */
const CORPUS_INDEX_FLIP_SAMPLE_MAX = 50;

/** Serving copies one coverage page reads at most. */
const CORPUS_INDEX_FLIP_COVERAGE_PAGE_MAX = 5000;

export class CorpusIndexFlipPairRefusedError extends TaggedError(
  "CorpusIndexFlipPairRefusedError",
)<{
  message: string;
  reason:
    | "same_generation"
    | "no_serving_generation"
    | "generation_not_active"
    | "partial_generation"
    | "serving_changed"
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

const generationOf = (
  table: typeof states | typeof intents,
  family: CorpusFamily,
  generation: string,
): SQL =>
  sql`${table.family} = ${family} AND ${table.generation} = ${generation}`;

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
          ${states.desiredAt}, ${states.workStatus},
          ${states.appliedAction}, ${states.appliedEpoch},
          ${states.appliedRevision}, ${states.appliedRevisionSettled},
          ${states.appliedIndexId}, ${states.appliedAt}, ${states.createdAt}
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
 * watermark compares exactly with the instants it is read against.
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
const candidateShows = sql`coalesce((
  ${candidateState.appliedIndexId} = ${candidateState.desiredIndexId}
  AND ${CORPUS_INDEX_PROJECTION_SERVING.served({ state: candidateState, revision: candidateRevision })}
), false)`;

/**
 * A regression the candidate will clear by itself within the watermark: its
 * state is ordinary pending work (not blocked, retrying or repairing; no copy
 * proven gone or being deleted), and the change is younger than the
 * watermark: the candidate was handed the newer content after it (`stale`),
 * or the decision itself is (`not_shown`, serving state created after it).
 */
const exemptAfter = (watermark: Temporal.Instant): SQL => {
  const at = sql`${microsecondToken(watermark)}::timestamptz`;
  // Every term is closed over NULL (a state that never applied has NULL
  // applied columns): an unknown is never an exemption, and the row is never
  // dropped from both the regressions and the exempt count.
  return sql`coalesce((
  ${candidateState.workStatus} = 'eligible'
  AND NOT coalesce(${corpusIndexProjectionIsAbsent(candidateState)}, false)
  AND NOT coalesce(${CORPUS_INDEX_PROJECTION_SERVING.at_risk({ state: candidateState, revision: candidateRevision })}, false)
  AND CASE WHEN ${candidateShows}
    THEN ${candidateState.desiredAt} > ${at}
    ELSE ${servingState.createdAt} > ${at}
  END
), false)`;
};

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
    behind AS (
      SELECT walked.entity_id::text AS entity_id,
        coalesce(${candidateState.desiredIndexId}, ${candidateState.appliedIndexId}) AS route,
        CASE WHEN ${candidateShows} THEN 'stale' ELSE 'not_shown' END AS kind,
        ${exemptAfter(watermark)} AS exempt,
        ${servingState.appliedEpoch}::text AS serving_epoch,
        ${candidateState.appliedEpoch}::text AS candidate_epoch
      FROM walked
      ${stateLookup("candidate_state", family, candidate)}
      ${namedRevisionLookup(candidateState, "candidate_revision")}
      ${stateLookup("serving_state", family, serving)}
      ${namedRevisionLookup(servingState, "serving_revision")}
      WHERE ${servingShows}
        AND NOT (
          ${candidateShows}
          AND ${candidateState.appliedEpoch} >= ${servingState.appliedEpoch}
        )
    ),
    regressions AS (
      SELECT * FROM behind WHERE NOT behind.exempt
    )
    SELECT
      (SELECT count(*) FROM pending_walk)::int AS pending_walked,
      (SELECT count(*) FROM blocked_walk)::int AS blocked_walked,
      (SELECT count(*) FROM absent_walk)::int AS absent_walked,
      (SELECT count(*) FROM at_risk_walk)::int AS at_risk_walked,
      (SELECT count(*) FROM behind WHERE behind.exempt)::int AS exempt,
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
          'candidate_epoch', sampled.candidate_epoch
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
};

type CorpusIndexFlipRouteCount = {
  route: string | null;
  kind: CorpusIndexFlipRegressionKind;
  count: number;
};

type CorpusIndexFlipWalked = {
  pending: number;
  blocked: number;
  absent: number;
  atRisk: number;
};

/**
 * `exact`: every walk reached its end, so `byRoute` holds every regression of
 * the pair and a route not listed has none. `at_least`: a walk stopped at the
 * cap, so only lower bounds are known; it has no `byRoute`, so no caller can
 * read an empty list from it.
 */
type CorpusIndexFlipRegressionReading =
  | {
      type: "exact";
      walked: CorpusIndexFlipWalked;
      byRoute: readonly CorpusIndexFlipRouteCount[];
      sample: readonly CorpusIndexFlipRegression[];
      exempt: number;
    }
  | {
      type: "at_least";
      walked: CorpusIndexFlipWalked;
      lowerBoundByRoute: readonly CorpusIndexFlipRouteCount[];
      sample: readonly CorpusIndexFlipRegression[];
      exempt: number;
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

const refused = (
  message: string,
  reason: CorpusIndexFlipPairRefusedError["reason"],
) => Result.err(new CorpusIndexFlipPairRefusedError({ message, reason }));

/**
 * The pair a flip of `candidate` would make: the family's serving generation
 * and the candidate. Refused when the read cannot answer it exactly: no
 * generation serves, the candidate is the serving one, the candidate does not
 * take every change (not building), the candidate is partial, or the family
 * has a jurisdiction-serving pointer. Erasures depend on the generation in
 * the last two cases.
 */
const readComparablePairTx = async (
  tx: Transaction,
  { family, candidate }: { family: CorpusFamily; candidate: string },
): Promise<Result<CorpusIndexFlipPair, CorpusIndexFlipParityError>> => {
  const failed = (cause: unknown) =>
    readError({ family, serving: "(serving)", candidate }, cause);
  if (
    corpusIndexManifestIsPartial(requireCorpusIndexManifest(family, candidate))
  ) {
    return refused(
      `${family}/${candidate} is a partial generation; it cannot replace the generation serving the whole family`,
      "partial_generation",
    );
  }
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
              eq(corpusIndexGenerations.family, family),
              or(
                eq(corpusIndexGenerations.generation, candidate),
                eq(corpusIndexGenerations.status, "serving"),
              ),
            ),
          ),
        2,
      ),
    catch: failed,
  });
  if (Result.isError(registered)) {
    return registered;
  }
  if (registered.value.type === "overflow") {
    // The candidate by its key, and the one serving row of the family.
    return panic("A generation pair matched more registry rows than names");
  }
  const rows = registered.value.rows;
  const serving = rows.find((row) => row.status === "serving");
  if (serving === undefined) {
    return refused(`No generation serves ${family}`, "no_serving_generation");
  }
  if (serving.generation === candidate) {
    return refused(
      `${family}/${candidate} already serves the family; a flip compares it with another generation`,
      "same_generation",
    );
  }
  const candidateRow = rows.find((row) => row.generation === candidate);
  if (candidateRow?.status !== "building") {
    return refused(
      `${family}/${candidate} is not a building generation (${candidateRow?.status ?? "not registered"}); only an active generation takes every change`,
      "generation_not_active",
    );
  }
  const pointers = await Result.tryPromise({
    try: async () => await readJurisdictionServingGenerationsTx(tx, family),
    catch: failed,
  });
  if (Result.isError(pointers)) {
    return pointers;
  }
  const [pointer] = pointers.value.keys();
  if (pointer !== undefined) {
    return refused(
      `${pointer} is served through a jurisdiction-serving pointer, which makes its erasures depend on the generation; a whole-family flip is not compared while one exists`,
      "jurisdiction_serving_pointer",
    );
  }
  return Result.ok({ family, serving: serving.generation, candidate });
};

const readRegressionsTx = async (
  tx: Transaction,
  pair: CorpusIndexFlipPair,
  watermark: Temporal.Instant,
): Promise<
  Result<CorpusIndexFlipRegressionReading, CorpusIndexFlipParityReadError>
> => {
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
  const counts = requiredArray(row, "by_route").map((entry) => ({
    route: nullableText(entry, "route"),
    kind: regressionKind(requiredText(entry, "kind")),
    count: requiredCount(entry, "count"),
  }));
  const sample = requiredArray(row, "sample").map((entry) => {
    const candidateEpoch = nullableText(entry, "candidate_epoch");
    return {
      entityId: requiredText(entry, "entity_id"),
      route: nullableText(entry, "route"),
      kind: regressionKind(requiredText(entry, "kind")),
      servingEpoch: BigInt(requiredText(entry, "serving_epoch")),
      candidateEpoch: candidateEpoch === null ? null : BigInt(candidateEpoch),
    };
  });
  const exempt = requiredCount(row, "exempt");
  const stopped = Object.values(walked).some(
    (count) => count > CORPUS_INDEX_FLIP_WALK_CAP,
  );
  return Result.ok(
    stopped
      ? { type: "at_least", walked, lowerBoundByRoute: counts, sample, exempt }
      : { type: "exact", walked, byRoute: counts, sample, exempt },
  );
};

/**
 * One page of the coverage walk: the serving generation's states in entity
 * order, read through its primary key, and among them the ones that want an
 * upsert while the candidate has no state at all. Every such state counts,
 * shown or not yet: one the serving generation applies after its page was
 * read would otherwise reach readers with nothing in the candidate, and the
 * regression statement, which walks candidate states, could not see it.
 */
export const corpusIndexFlipCoveragePageQuery = (
  pair: CorpusIndexFlipPair,
  { after, limit }: { after: string | null; limit: number },
): SQL => {
  const { family, serving, candidate } = pair;
  return sql`
    WITH walked AS MATERIALIZED (
      SELECT ${states.entityId} AS entity_id,
        ${states.desiredAction} AS desired_action
      FROM ${states}
      WHERE ${generationOf(states, family, serving)}${
        after === null
          ? sql``
          : sql`
        AND ${states.entityId} > ${after}::uuid`
      }
      ORDER BY ${states.entityId}
      LIMIT ${limit}
    ),
    missing AS (
      SELECT walked.entity_id::text AS entity_id
      FROM walked
      -- One primary-key probe per state: as an anti-join the planner may
      -- read the candidate's states whole.
      LEFT JOIN LATERAL (
        SELECT true AS present
        FROM ${states}
        WHERE ${generationOf(states, family, candidate)}
          AND ${states.entityId} = walked.entity_id
        LIMIT 1
      ) candidate_presence ON true
      WHERE walked.desired_action = 'upsert'
        AND candidate_presence.present IS NULL
    )
    SELECT
      (SELECT count(*) FROM walked)::int AS walked,
      (
        SELECT walked.entity_id::text FROM walked
        ORDER BY walked.entity_id DESC
        LIMIT 1
      ) AS last_entity_id,
      (SELECT count(*) FROM missing)::int AS missing,
      coalesce((
        SELECT json_agg(sampled.entity_id ORDER BY sampled.entity_id)
        FROM (
          SELECT entity_id FROM missing
          ORDER BY entity_id
          LIMIT ${CORPUS_INDEX_FLIP_SAMPLE_MAX}
        ) AS sampled
      ), '[]'::json) AS sample`;
};

/** Where a coverage walk stands: the last serving state it read. */
export type CorpusIndexFlipCoverageCursor = { after: string | null };

type CorpusIndexFlipCoverage =
  | {
      /** The walk read every serving state from the first on. */
      type: "complete";
      walked: number;
      missing: number;
      sample: readonly string[];
    }
  | {
      /**
       * The walk did not read every state: its page budget ran out (`next`
       * says where to resume), or it resumed from a cursor.
       */
      type: "incomplete";
      walked: number;
      missing: number;
      sample: readonly string[];
      next: CorpusIndexFlipCoverageCursor | null;
    };

/**
 * The one verdict a caller acts on. `no_regression` only when the coverage
 * walk read every serving state and found none missing, and the regression
 * statement was exact and empty.
 */
type CorpusIndexFlipVerdict =
  | { type: "no_regression" }
  | { type: "regressions"; missing: number; regressions: number }
  | {
      type: "undecided";
      reason: "walk_capped" | "coverage_incomplete";
      knownMissing: number;
      knownRegressions: number;
    };

export type CorpusIndexFlipParity = {
  pair: CorpusIndexFlipPair;
  watermark: Temporal.Instant;
  coverage: CorpusIndexFlipCoverage;
  regressions: CorpusIndexFlipRegressionReading;
  verdict: CorpusIndexFlipVerdict;
};

const verdictOf = (
  coverage: CorpusIndexFlipCoverage,
  regressions: CorpusIndexFlipRegressionReading,
): CorpusIndexFlipVerdict => {
  const sum = (counts: readonly CorpusIndexFlipRouteCount[]) =>
    counts.reduce((total, { count }) => total + count, 0);
  switch (regressions.type) {
    case "at_least":
      return {
        type: "undecided",
        reason: "walk_capped",
        knownMissing: coverage.missing,
        knownRegressions: sum(regressions.lowerBoundByRoute),
      };
    case "exact": {
      const found = sum(regressions.byRoute);
      if (coverage.missing > 0 || found > 0) {
        return {
          type: "regressions",
          missing: coverage.missing,
          regressions: found,
        };
      }
      return coverage.type === "complete"
        ? { type: "no_regression" }
        : {
            type: "undecided",
            reason: "coverage_incomplete",
            knownMissing: 0,
            knownRegressions: 0,
          };
    }
    default:
      regressions satisfies never;
      return panic("Unhandled flip regression reading");
  }
};

type CoverageWalkOptions = {
  /** Serving states per page, at most `CORPUS_INDEX_FLIP_COVERAGE_PAGE_MAX`. */
  pageSize: number;
  /** Pages this call may read; 0 skips the walk. */
  pageBudget: number;
  /** Resume an earlier walk; a resumed walk can never prove completeness. */
  resumeFrom: CorpusIndexFlipCoverageCursor | null;
};

type ProjectionTransactionRunner = IngestionTransactionRunner<Transaction>;

type CoveragePage = {
  walked: number;
  missing: number;
  sample: readonly string[];
  next: string | null;
};

const readCoveragePage = async (
  runInTransaction: ProjectionTransactionRunner,
  pair: CorpusIndexFlipPair,
  { after, limit }: { after: string | null; limit: number },
): Promise<Result<CoveragePage, CorpusIndexFlipParityReadError>> => {
  const rows = await runInTransaction(
    async (tx) =>
      await readRows(
        tx,
        corpusIndexFlipCoveragePageQuery(pair, { after, limit }),
        pair,
      ),
  );
  if (Result.isError(rows)) {
    return rows;
  }
  const row = rows.value.at(0);
  const walked = requiredCount(row, "walked");
  return Result.ok({
    walked,
    missing: requiredCount(row, "missing"),
    sample: requiredArray(row, "sample").map((entry) =>
      typeof entry === "string"
        ? entry
        : panic("Malformed flip parity row: coverage sample"),
    ),
    next: walked < limit ? null : nullableText(row, "last_entity_id"),
  });
};

/**
 * Walk the serving generation's states, one short read-only transaction per
 * page, within the page budget.
 */
const walkCoverage = async (
  runInTransaction: ProjectionTransactionRunner,
  pair: CorpusIndexFlipPair,
  { pageSize, pageBudget, resumeFrom }: CoverageWalkOptions,
): Promise<Result<CorpusIndexFlipCoverage, CorpusIndexFlipParityReadError>> => {
  const sample: string[] = [];
  const tally = { walked: 0, missing: 0, sample, pages: 0 };
  let after = resumeFrom?.after ?? null;
  for (;;) {
    if (tally.pages >= pageBudget) {
      return Result.ok({
        type: "incomplete",
        walked: tally.walked,
        missing: tally.missing,
        sample: tally.sample,
        next: { after },
      });
    }
    // db-await-in-loop: a keyset walk; each page's cursor comes from the one before it
    const page = await readCoveragePage(runInTransaction, pair, {
      after,
      limit: pageSize,
    });
    if (Result.isError(page)) {
      return page;
    }
    tally.pages += 1;
    tally.walked += page.value.walked;
    tally.missing += page.value.missing;
    tally.sample.push(
      ...page.value.sample.slice(
        0,
        Math.max(0, CORPUS_INDEX_FLIP_SAMPLE_MAX - tally.sample.length),
      ),
    );
    if (page.value.next === null) {
      break;
    }
    after = page.value.next;
  }
  return Result.ok(
    resumeFrom === null
      ? {
          type: "complete",
          walked: tally.walked,
          missing: tally.missing,
          sample: tally.sample,
        }
      : {
          type: "incomplete",
          walked: tally.walked,
          missing: tally.missing,
          sample: tally.sample,
          next: null,
        },
  );
};

/** The watermark `exemptMinutes` before the database clock. */
const readWatermarkTx = async (
  tx: Transaction,
  exemptMinutes: number,
): Promise<Temporal.Instant> => {
  const rows = executedRows(
    await tx.execute(
      sql`SELECT ${epochMicros(sql`clock_timestamp()`)}::text AS now_us`,
    ),
  );
  return instantFromMicros(requiredText(rows.at(0), "now_us")).subtract({
    minutes: exemptMinutes,
  });
};

/**
 * What a flip of `candidate` would lose against the family's serving
 * generation: the coverage walk first, then the regression statement, in that
 * order (see the module comment), and the verdict decided from both.
 *
 * `runInTransaction` should open read-only transactions. Each coverage page
 * and the regression statement are separate snapshots, which the order above
 * makes sound. The pair checks and the regression statement share the last
 * transaction; a flip that acts on the verdict must hold the exclusive
 * projection fence (or run REPEATABLE READ) across that transaction and its
 * own write, so nothing the checks read changes before it flips.
 */
export const readCorpusIndexFlipParity = async ({
  runInTransaction,
  family,
  candidate,
  exemptMinutes,
  coverage,
}: {
  runInTransaction: ProjectionTransactionRunner;
  family: CorpusFamily;
  candidate: string;
  exemptMinutes: number;
  coverage: CoverageWalkOptions;
}): Promise<Result<CorpusIndexFlipParity, CorpusIndexFlipParityError>> => {
  if (!Number.isSafeInteger(exemptMinutes) || exemptMinutes < 0) {
    return panic(`Invalid flip watermark: ${exemptMinutes} minutes`);
  }
  if (
    !Number.isSafeInteger(coverage.pageSize) ||
    coverage.pageSize < 1 ||
    coverage.pageSize > CORPUS_INDEX_FLIP_COVERAGE_PAGE_MAX ||
    !Number.isSafeInteger(coverage.pageBudget) ||
    coverage.pageBudget < 0
  ) {
    return panic("Invalid flip coverage walk options");
  }
  const pair = await runInTransaction(
    async (tx) => await readComparablePairTx(tx, { family, candidate }),
  );
  if (Result.isError(pair)) {
    return pair;
  }
  const walked = await walkCoverage(runInTransaction, pair.value, coverage);
  if (Result.isError(walked)) {
    return walked;
  }
  const read = await runInTransaction(async (tx) => {
    // The pair is checked again where the regression statement reads, so a
    // registry or pointer change during the walk is not compared past.
    const again = await readComparablePairTx(tx, { family, candidate });
    if (Result.isError(again)) {
      return Result.err(again.error);
    }
    if (again.value.serving !== pair.value.serving) {
      return refused(
        `${family} changed its serving generation during the read`,
        "serving_changed",
      );
    }
    const watermark = await readWatermarkTx(tx, exemptMinutes);
    const regressions = await readRegressionsTx(tx, again.value, watermark);
    return Result.isError(regressions)
      ? regressions
      : Result.ok({ watermark, regressions: regressions.value });
  });
  if (Result.isError(read)) {
    return read;
  }
  return Result.ok({
    pair: pair.value,
    watermark: read.value.watermark,
    coverage: walked.value,
    regressions: read.value.regressions,
    verdict: verdictOf(walked.value, read.value.regressions),
  });
};
