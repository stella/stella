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
 *   counter (`corpus-index-projection-desired-state.db.test.ts` pins it).
 *   No database trigger enforces this in production, on purpose: it would
 *   read the canonical row of another table on every desired-state write,
 *   the projection's hottest path, and under concurrent writers it would
 *   fail a correct write whenever a canonical update commits between the
 *   writer's read and the trigger's snapshot. Every writer suite installs
 *   the test guard instead (`tests/helpers/corpus-projection-canonical-epoch-guard.ts`);
 *   a new desired-state writer must run under it;
 * - whether a decision is erased does not depend on the generation, except
 *   through a jurisdiction-serving pointer (`vacatedFrom`) or a partial
 *   generation's scope. The read refuses both, except a pointer that serves
 *   a jurisdiction from the candidate in place of the serving generation (a
 *   fallback's): the flip does not move that jurisdiction's readers, so its
 *   decisions are left out of the comparison, as are those of a jurisdiction
 *   a recorded fallback policy keeps on the serving generation
 *   (`corpus-index-fallback-policy.ts`). Which decisions those are is read
 *   from each canonical decision's jurisdiction, never from its route.
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
 * `walkCorpusIndexFlipCoverage` and `decideCorpusIndexFlipParityTx` own that
 * order: a verdict is decided only from a walk, in the transaction that reads
 * the regressions (`readCorpusIndexFlipParity` runs both).
 *
 * What the decision re-reads, and why that is enough. The walk is long (one
 * page per serving state, about 10,000 pages at 10 M states), so it runs in
 * short transactions and no fence can be held across it. The decision runs
 * in one transaction, which a flip holds under the exclusive projection
 * fence, and re-reads everything that could have moved since:
 *
 * - the pair, by its registry rows' identity (status and update time): a
 *   rebuild, the only thing that deletes projection states, changes them, so
 *   every candidate state the walk counted is still there;
 * - the tail: every serving state after the last one the walk read, exactly.
 *   Decision ids are time ordered, so this is where new decisions land;
 * - behind the cursor: every serving state created after its page was read,
 *   and every serving state the walk saw with no candidate state that has
 *   come to want an upsert since. The walk keeps each page's bounds and count
 *   and lists the serving states it found with no candidate state that wanted
 *   no upsert; the decision counts every page again (one index-only range
 *   count per page) and re-reads the pages whose count moved and the listed
 *   states, by primary key. Nothing deletes a state of an active generation
 *   (a database trigger allows it only once the generation is retired), so a
 *   page whose count did not move holds exactly the states the walk read, and
 *   a page whose count fell refuses as undecided. No writer contract is
 *   trusted for this: a writer that gives the serving generation a state and
 *   the candidate none is caught however it came to do so. Measured on 2 M
 *   serving states, the recount takes 0.1 to 0.3 s (all-visible or not), so
 *   about 1 to 1.5 s at 10 M, under the fence.
 *
 * The other order, holding writers back for the whole walk, would pause every
 * projection writer for tens of minutes at 10 M states.
 */
import { panic, Result, TaggedError } from "better-result";
import { and, eq, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { declareFingerprintFields } from "@stll/errors";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { executedRows } from "@/api/lib/db/executed-rows";
import { readBounded } from "@/api/lib/db/read-bounded";
import {
  type CorpusFamily,
  isActiveCorpusIndexGenerationStatus,
} from "@/api/lib/legal-search/corpus-generation-contract";
import { readCorpusIndexFallbackKeepTx } from "@/api/lib/legal-search/corpus-index-fallback-policy";
import { readJurisdictionServingPointersTx } from "@/api/lib/legal-search/corpus-index-jurisdiction-serving-store";
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
  /**
   * Jurisdictions a recorded fallback policy keeps on the serving generation
   * (`corpus-index-fallback-policy.ts`): the flip does not move their
   * readers, so they are not compared. Empty without such a policy.
   */
  keptOnServing: readonly string[];
  /**
   * Jurisdictions already served by the candidate through a pointer a
   * fallback left (moved from the serving generation): their readers do not
   * move either. Any other pointer refuses the comparison.
   */
  pinnedOnCandidate: readonly string[];
};

/** The jurisdictions whose readers the flip leaves where they are, sorted. */
export const corpusIndexFlipUnmovedJurisdictions = (
  pair: Pick<CorpusIndexFlipPair, "keptOnServing" | "pinnedOnCandidate">,
): readonly string[] =>
  [...new Set([...pair.keptOnServing, ...pair.pinnedOnCandidate])].toSorted();

/**
 * Whether the decision `entity` names belongs to a jurisdiction whose readers
 * the flip does not move. Read from the canonical decision by primary key, so
 * a jurisdiction is never told from a route: one physical index can hold
 * several jurisdictions. A decision with no canonical row is compared.
 */
const unmovedEntity = (pair: CorpusIndexFlipPair, entity: SQL): SQL => {
  const unmoved = corpusIndexFlipUnmovedJurisdictions(pair);
  return unmoved.length === 0
    ? sql`false`
    : sql`EXISTS (
        SELECT 1 FROM ${caseLawDecisions}
        WHERE ${caseLawDecisions.id} = ${entity}
          AND ${caseLawDecisions.country} IN (${sql.join(
            unmoved.map((jurisdiction) => sql`${jurisdiction}`),
            sql`, `,
          )})
      )`;
};

/**
 * The pair as the registry held it: each row's status and last update, in
 * epoch microseconds. Every lifecycle transition rewrites both, so an equal
 * identity means neither generation moved in between.
 */
type CorpusIndexFlipPairIdentity = CorpusIndexFlipPair & {
  servingUpdatedAtUs: string;
  candidateUpdatedAtUs: string;
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

/**
 * Serving states the decision re-reads after the walk's last one, at most.
 * The tail holds what arrived since the walk ended (minutes of inflow); a
 * longer tail leaves the verdict undecided, and walking again shortens it.
 */
const CORPUS_INDEX_FLIP_TAIL_MAX = 5000;

/**
 * Serving states the walk lists for the decision to probe again: those it
 * found with no candidate state while they wanted no upsert (erased or
 * withheld before the candidate was seeded). Past this many the walk cannot
 * prove coverage. Probing 100,000 by primary key took 3 to 4 s on 2 M states.
 */
const CORPUS_INDEX_FLIP_UNCOVERED_MAX = 50_000;

/**
 * Serving states the decision re-reads in pages whose count moved behind the
 * walk's cursor, at most; past it the verdict is undecided and walking again
 * (when the inflow behind the cursor is quieter) settles it.
 */
const CORPUS_INDEX_FLIP_RECHECK_MAX = 50_000;

/** The smallest uuid: the first page's lower bound, inclusive. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

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
    | "generation_changed"
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
 * be in flight. An unknown counts as shown, so the serving side is
 * conservative by construction, not only because a foreign key keeps every
 * named revision present.
 */
const servingShows = sql`coalesce((
  ${servingState.appliedIndexId} = ${servingState.desiredIndexId}
  AND (
    ${CORPUS_INDEX_PROJECTION_SERVING.served({ state: servingState, revision: servingRevision })}
    OR ${CORPUS_INDEX_PROJECTION_SERVING.at_risk({ state: servingState, revision: servingRevision })}
  )
), true)`;

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
        AND NOT ${unmovedEntity(pair, sql`walked.entity_id`)}
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

const readError = (
  pair: Pick<CorpusIndexFlipPair, "family" | "serving" | "candidate">,
  cause: unknown,
) =>
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

type ProjectionTransactionRunner = IngestionTransactionRunner<Transaction>;

/**
 * One read in its own transaction. A failed read rolls the transaction back
 * and comes back as its Err: a statement the database cut short has aborted
 * the transaction, so it must never be asked to commit.
 */
const readInTransaction = async <T, E>(
  runInTransaction: ProjectionTransactionRunner,
  read: (tx: Transaction) => Promise<Result<T, E>>,
): Promise<Result<T, E>> => {
  const failed: { error?: E } = {};
  const ran = await Result.tryPromise({
    try: async () =>
      await runInTransaction(async (tx) => {
        const result = await read(tx);
        if (result.isErr()) {
          failed.error = result.error;
          tx.rollback();
        }
        return result;
      }),
    catch: (cause) => cause,
  });
  if (failed.error !== undefined) {
    return Result.err(failed.error);
  }
  return ran.isOk()
    ? ran.value
    : panic("A flip parity read failed outside its statements", ran.error);
};

const refused = (
  message: string,
  reason: CorpusIndexFlipPairRefusedError["reason"],
) => Result.err(new CorpusIndexFlipPairRefusedError({ message, reason }));

/**
 * The pair a flip of `candidate` would make: the family's serving generation
 * and the candidate. Refused when the read cannot answer it exactly: no
 * generation serves, the candidate is the serving one, the candidate does not
 * take every change (not active), the candidate is partial, or the family
 * has a jurisdiction-serving pointer other than one a fallback left on the
 * candidate. Erasures depend on the generation in the last two cases.
 *
 * The pair also names the jurisdictions whose readers the flip leaves where
 * they are: those a recorded fallback policy keeps on the serving generation,
 * and those a fallback pinned on the candidate. Their decisions are not
 * compared; every other decision, on a shared index too, is.
 */
const readComparablePairTx = async (
  tx: Transaction,
  { family, candidate }: { family: CorpusFamily; candidate: string },
): Promise<Result<CorpusIndexFlipPairIdentity, CorpusIndexFlipParityError>> => {
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
            updatedAtUs: sql<string>`${epochMicros(sql`${corpusIndexGenerations.updatedAt}`)}::text`,
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
  // The serving generation was refused above, so an active candidate is a
  // building one.
  if (
    candidateRow === undefined ||
    !isActiveCorpusIndexGenerationStatus(candidateRow.status)
  ) {
    return refused(
      `${family}/${candidate} is not an active generation (${candidateRow?.status ?? "not registered"}); only an active generation takes every change`,
      "generation_not_active",
    );
  }
  const unmoved = await Result.tryPromise({
    try: async () => ({
      pointers: await readJurisdictionServingPointersTx(tx, family),
      keep: await readCorpusIndexFallbackKeepTx(tx, {
        family,
        serving: serving.generation,
        target: candidate,
      }),
    }),
    catch: failed,
  });
  if (Result.isError(unmoved)) {
    return unmoved;
  }
  const { pointers, keep } = unmoved.value;
  // A pointer a fallback left on the candidate moves no reader (the candidate
  // serves the jurisdiction now and after), so the comparison leaves it out.
  // Any other pointer makes a jurisdiction's erasures depend on a generation
  // the comparison does not follow.
  const foreign = pointers.find(
    (pointer) =>
      family !== "case_law" ||
      pointer.generation !== candidate ||
      pointer.fromGeneration !== serving.generation,
  );
  if (foreign !== undefined) {
    return refused(
      `${foreign.jurisdiction} is served through a jurisdiction-serving pointer to ${foreign.generation}, which makes its erasures depend on the generation; a whole-family flip is compared only while every pointer serves the candidate in place of the serving generation`,
      "jurisdiction_serving_pointer",
    );
  }
  return Result.ok({
    family,
    serving: serving.generation,
    candidate,
    keptOnServing: keep?.keepOnNewer ?? [],
    pinnedOnCandidate: pointers.map(({ jurisdiction }) => jurisdiction),
    servingUpdatedAtUs: serving.updatedAtUs,
    candidateUpdatedAtUs: candidateRow.updatedAtUs,
  });
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
 * regression statement, which walks candidate states, could not see it. The
 * ones with no candidate state that want no upsert are listed (`uncovered`):
 * they are no loss now, and the decision probes them again under the fence.
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
    probed AS MATERIALIZED (
      SELECT walked.entity_id::text AS entity_id,
        walked.desired_action = 'upsert' AS wants_upsert
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
      WHERE candidate_presence.present IS NULL
        AND NOT ${unmovedEntity(pair, sql`walked.entity_id`)}
    )
    SELECT
      (SELECT count(*) FROM walked)::int AS walked,
      (
        SELECT walked.entity_id::text FROM walked
        ORDER BY walked.entity_id DESC
        LIMIT 1
      ) AS last_entity_id,
      (SELECT count(*) FROM probed WHERE probed.wants_upsert)::int AS missing,
      coalesce((
        SELECT json_agg(sampled.entity_id ORDER BY sampled.entity_id)
        FROM (
          SELECT entity_id FROM probed
          WHERE probed.wants_upsert
          ORDER BY entity_id
          LIMIT ${CORPUS_INDEX_FLIP_SAMPLE_MAX}
        ) AS sampled
      ), '[]'::json) AS sample,
      coalesce((
        SELECT json_agg(probed.entity_id ORDER BY probed.entity_id)
        FROM probed
        WHERE NOT probed.wants_upsert
      ), '[]'::json) AS uncovered`;
};

/** One walked page as the decision counts it again: its bounds and count. */
type CorpusIndexFlipCoveragePageBound = {
  /** Exclusive lower bound; null for the first page (from the start). */
  after: string | null;
  /** Inclusive upper bound: the last state the page read. */
  last: string;
  walked: number;
};

/** The serving states of `pages`, as a range join over their bounds. */
const pageRanges = (
  pages: readonly { after: string | null; last: string }[],
): SQL =>
  sql`jsonb_to_recordset(${JSON.stringify(
    pages.map(({ after, last }) => ({ after_id: after, last_id: last })),
  )}::text::jsonb) AS page(after_id uuid, last_id uuid)`;

/** The serving states one page's bounds hold, read through the primary key. */
const inPage = (family: CorpusFamily, serving: string): SQL => sql`
          ${generationOf(states, family, serving)}
          AND ${states.entityId} >= coalesce(page.after_id, ${NIL_UUID}::uuid)
          AND ${states.entityId} <= page.last_id
          AND (page.after_id IS NULL OR ${states.entityId} <> page.after_id)`;

/**
 * Every walked page counted again: one index-only range count per page, and
 * only the pages whose count moved come back. Under the fence, a page whose
 * count did not move holds exactly the states the walk read there.
 */
export const corpusIndexFlipPageRecountQuery = (
  pair: CorpusIndexFlipPair,
  pages: readonly CorpusIndexFlipCoveragePageBound[],
): SQL => {
  const { family, serving } = pair;
  return sql`
    SELECT page.after_id::text AS after_id, page.last_id::text AS last_id,
      page.walked, counted.states
    FROM jsonb_to_recordset(${JSON.stringify(
      pages.map(({ after, last, walked }) => ({
        after_id: after,
        last_id: last,
        walked,
      })),
    )}::text::jsonb) AS page(after_id uuid, last_id uuid, walked int)
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS states
      FROM ${states}
      WHERE ${inPage(family, serving)}
    ) counted
    WHERE counted.states <> page.walked`;
};

/**
 * The serving states of the pages whose count moved, and the listed states
 * the walk found with no candidate state, read again: each probed by primary
 * key in both generations. A state that wants an upsert with no candidate
 * state is missing; a listed state with no serving state left was removed.
 */
export const corpusIndexFlipBehindCursorQuery = (
  pair: CorpusIndexFlipPair,
  {
    pages,
    listed,
  }: {
    pages: readonly { after: string | null; last: string }[];
    listed: readonly string[];
  },
): SQL => {
  const { family, serving, candidate } = pair;
  return sql`
    WITH reread AS MATERIALIZED (
      SELECT in_page.entity_id
      FROM ${pageRanges(pages)}
      CROSS JOIN LATERAL (
        SELECT ${states.entityId} AS entity_id
        FROM ${states}
        WHERE ${inPage(family, serving)}
      ) in_page
      UNION
      SELECT listed.entity_id::uuid
      FROM jsonb_array_elements_text(${JSON.stringify(listed)}::text::jsonb) AS listed(entity_id)
    ),
    probed AS MATERIALIZED (
      SELECT reread.entity_id::text AS entity_id,
        serving_now.desired_action,
        candidate_presence.present,
        ${unmovedEntity(pair, sql`reread.entity_id`)} AS unmoved
      FROM reread
      LEFT JOIN LATERAL (
        SELECT ${states.desiredAction} AS desired_action
        FROM ${states}
        WHERE ${generationOf(states, family, serving)}
          AND ${states.entityId} = reread.entity_id
        LIMIT 1
      ) serving_now ON true
      LEFT JOIN LATERAL (
        SELECT true AS present
        FROM ${states}
        WHERE ${generationOf(states, family, candidate)}
          AND ${states.entityId} = reread.entity_id
        LIMIT 1
      ) candidate_presence ON true
    )
    SELECT
      (SELECT count(*) FROM probed)::int AS reread,
      (SELECT count(*) FROM probed WHERE probed.desired_action IS NULL)::int AS removed,
      (
        SELECT count(*) FROM probed
        WHERE probed.desired_action = 'upsert' AND probed.present IS NULL
          AND NOT probed.unmoved
      )::int AS missing,
      coalesce((
        SELECT json_agg(sampled.entity_id ORDER BY sampled.entity_id)
        FROM (
          SELECT entity_id FROM probed
          WHERE probed.desired_action = 'upsert' AND probed.present IS NULL
            AND NOT probed.unmoved
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
 * The serving states the walk found with no candidate state that wanted no
 * upsert, listed for the decision to probe again; or only their number, once
 * past `CORPUS_INDEX_FLIP_UNCOVERED_MAX`.
 */
type CorpusIndexFlipUncovered =
  | { type: "listed"; entityIds: readonly string[] }
  | { type: "too_many"; count: number };

/** Why the decision cannot prove what changed behind the walk's cursor. */
type CorpusIndexFlipBehindCursorUnprovable =
  "states_removed" | "too_many_changed" | "too_many_uncovered";

/** What the decision read behind the walk's cursor. */
type CorpusIndexFlipBehindCursor =
  | {
      type: "read";
      /** Pages counted again. */
      pages: number;
      /** Pages whose count moved since the walk read them. */
      changedPages: number;
      /** Serving states probed again: the moved pages' and the listed ones. */
      reread: number;
      /** Of those, the ones that want an upsert with no candidate state. */
      missing: number;
      sample: readonly string[];
    }
  /** The walk did not reach the end, so there is nothing behind it to prove. */
  | { type: "not_read" }
  | { type: "unprovable"; reason: CorpusIndexFlipBehindCursorUnprovable };

/**
 * The one verdict a caller acts on. `no_regression` only when the coverage
 * walk read every serving state and found none missing, nothing behind its
 * cursor is missing, and the regression statement was exact and empty.
 */
type CorpusIndexFlipVerdict =
  | { type: "no_regression" }
  | { type: "regressions"; missing: number; regressions: number }
  | {
      type: "undecided";
      reason:
        | "walk_capped"
        | "coverage_incomplete"
        | "coverage_tail_long"
        | CorpusIndexFlipBehindCursorUnprovable;
      knownMissing: number;
      knownRegressions: number;
    };

export type CorpusIndexFlipParity = {
  pair: CorpusIndexFlipPairIdentity;
  watermark: Temporal.Instant;
  /**
   * The walk's coverage, with what the decision found missing in the tail
   * and behind the cursor added to it.
   */
  coverage: CorpusIndexFlipCoverage;
  tail: CorpusIndexFlipTail;
  behindCursor: CorpusIndexFlipBehindCursor;
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

type CoveragePage = {
  walked: number;
  missing: number;
  sample: readonly string[];
  /** States read with no candidate state that wanted no upsert. */
  uncovered: readonly string[];
  /** The last serving state the page read; null when it read none. */
  last: string | null;
  next: string | null;
};

const entityIdsOf = (row: unknown, key: string): string[] =>
  requiredArray(row, key).map((entry) =>
    typeof entry === "string"
      ? entry
      : panic(`Malformed flip parity row: ${key}`),
  );

const readCoveragePage = async (
  runInTransaction: ProjectionTransactionRunner,
  pair: CorpusIndexFlipPair,
  { after, limit }: { after: string | null; limit: number },
): Promise<Result<CoveragePage, CorpusIndexFlipParityReadError>> => {
  const rows = await readInTransaction(
    runInTransaction,
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
    sample: entityIdsOf(row, "sample"),
    uncovered: entityIdsOf(row, "uncovered"),
    last: nullableText(row, "last_entity_id"),
    next: walked < limit ? null : nullableText(row, "last_entity_id"),
  });
};

type WalkedCoverage = {
  coverage: CorpusIndexFlipCoverage;
  last: string | null;
  pages: readonly CorpusIndexFlipCoveragePageBound[];
  uncovered: CorpusIndexFlipUncovered;
};

/**
 * Walk the serving generation's states, one short read-only transaction per
 * page, within the page budget, keeping each page's bounds and count and the
 * states it found with no candidate state that wanted no upsert.
 */
const walkCoverage = async (
  runInTransaction: ProjectionTransactionRunner,
  pair: CorpusIndexFlipPair,
  { pageSize, pageBudget, resumeFrom }: CoverageWalkOptions,
): Promise<Result<WalkedCoverage, CorpusIndexFlipParityReadError>> => {
  const sample: string[] = [];
  const pages: CorpusIndexFlipCoveragePageBound[] = [];
  const uncovered: string[] = [];
  const tally = { walked: 0, missing: 0, uncovered: 0, pages: 0 };
  const listedUncovered = (): CorpusIndexFlipUncovered =>
    tally.uncovered > CORPUS_INDEX_FLIP_UNCOVERED_MAX
      ? { type: "too_many", count: tally.uncovered }
      : { type: "listed", entityIds: uncovered };
  let after = resumeFrom?.after ?? null;
  let last = after;
  for (;;) {
    if (tally.pages >= pageBudget) {
      return Result.ok({
        coverage: {
          type: "incomplete",
          walked: tally.walked,
          missing: tally.missing,
          sample,
          next: { after },
        },
        last,
        pages,
        uncovered: listedUncovered(),
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
    if (page.value.last !== null) {
      pages.push({ after, last: page.value.last, walked: page.value.walked });
    }
    last = page.value.last ?? last;
    tally.walked += page.value.walked;
    tally.missing += page.value.missing;
    tally.uncovered += page.value.uncovered.length;
    if (tally.uncovered <= CORPUS_INDEX_FLIP_UNCOVERED_MAX) {
      uncovered.push(...page.value.uncovered);
    }
    sample.push(
      ...page.value.sample.slice(
        0,
        Math.max(0, CORPUS_INDEX_FLIP_SAMPLE_MAX - sample.length),
      ),
    );
    if (page.value.next === null) {
      break;
    }
    after = page.value.next;
  }
  return Result.ok({
    coverage:
      resumeFrom === null
        ? {
            type: "complete",
            walked: tally.walked,
            missing: tally.missing,
            sample,
          }
        : {
            type: "incomplete",
            walked: tally.walked,
            missing: tally.missing,
            sample,
            next: null,
          },
    last,
    pages,
    uncovered: listedUncovered(),
  });
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

const COVERAGE_WALK = Symbol("corpus-index-flip-coverage-walk");

/**
 * A finished coverage walk. Only `walkCorpusIndexFlipCoverage` makes one, so a
 * verdict is never decided from a walk that did not happen first.
 */
export type CorpusIndexFlipCoverageWalk = {
  readonly [COVERAGE_WALK]: true;
  pair: CorpusIndexFlipPairIdentity;
  coverage: CorpusIndexFlipCoverage;
  /** The last serving state the walk read; the decision's tail starts after it. */
  last: string | null;
  /** Every page the walk read a state in, with its bounds and count. */
  pages: readonly CorpusIndexFlipCoveragePageBound[];
  uncovered: CorpusIndexFlipUncovered;
};

const requireValidOptions = (
  exemptMinutes: number,
  coverage: CoverageWalkOptions | null,
): void => {
  if (!Number.isSafeInteger(exemptMinutes) || exemptMinutes < 0) {
    panic(`Invalid flip watermark: ${exemptMinutes} minutes`);
  }
  if (
    coverage !== null &&
    (!Number.isSafeInteger(coverage.pageSize) ||
      coverage.pageSize < 1 ||
      coverage.pageSize > CORPUS_INDEX_FLIP_COVERAGE_PAGE_MAX ||
      !Number.isSafeInteger(coverage.pageBudget) ||
      coverage.pageBudget < 0)
  ) {
    panic("Invalid flip coverage walk options");
  }
};

/**
 * The first half of a parity read: the pair, then the coverage walk over the
 * serving generation's states, one short transaction per page (read-only
 * ones will do). No fence is held; `decideCorpusIndexFlipParityTx` makes the
 * result valid in the transaction that decides.
 */
export const walkCorpusIndexFlipCoverage = async ({
  runInTransaction,
  family,
  candidate,
  coverage,
}: {
  runInTransaction: ProjectionTransactionRunner;
  family: CorpusFamily;
  candidate: string;
  coverage: CoverageWalkOptions;
}): Promise<
  Result<CorpusIndexFlipCoverageWalk, CorpusIndexFlipParityError>
> => {
  requireValidOptions(0, coverage);
  const pair = await readInTransaction(
    runInTransaction,
    async (tx) => await readComparablePairTx(tx, { family, candidate }),
  );
  if (Result.isError(pair)) {
    return pair;
  }
  const walked = await walkCoverage(runInTransaction, pair.value, coverage);
  if (Result.isError(walked)) {
    return walked;
  }
  return Result.ok({
    [COVERAGE_WALK]: true,
    pair: pair.value,
    ...walked.value,
  });
};

/** What the decision read after the walk's last serving state. */
type CorpusIndexFlipTail =
  | { type: "read"; walked: number; missing: number; sample: readonly string[] }
  | { type: "too_long" }
  /** The walk did not reach the end, so there is no tail to read. */
  | { type: "not_read" };

const readTailTx = async (
  tx: Transaction,
  walk: CorpusIndexFlipCoverageWalk,
): Promise<Result<CorpusIndexFlipTail, CorpusIndexFlipParityReadError>> => {
  if (walk.coverage.type !== "complete") {
    return Result.ok({ type: "not_read" });
  }
  const rows = await readRows(
    tx,
    corpusIndexFlipCoveragePageQuery(walk.pair, {
      after: walk.last,
      limit: CORPUS_INDEX_FLIP_TAIL_MAX + 1,
    }),
    walk.pair,
  );
  if (Result.isError(rows)) {
    return rows;
  }
  const row = rows.value.at(0);
  const walked = requiredCount(row, "walked");
  return Result.ok(
    walked > CORPUS_INDEX_FLIP_TAIL_MAX
      ? { type: "too_long" }
      : {
          type: "read",
          walked,
          missing: requiredCount(row, "missing"),
          sample: entityIdsOf(row, "sample"),
        },
  );
};

/**
 * Behind the walk's cursor, under the decision's fence: every page counted
 * again, the pages whose count moved and the listed uncovered states probed
 * again. Refuses to prove anything when a count fell (a state removed, which
 * only a retired generation allows) or when more moved than it re-reads.
 */
const readBehindCursorTx = async (
  tx: Transaction,
  walk: CorpusIndexFlipCoverageWalk,
): Promise<
  Result<CorpusIndexFlipBehindCursor, CorpusIndexFlipParityReadError>
> => {
  if (walk.coverage.type !== "complete") {
    return Result.ok({ type: "not_read" });
  }
  if (walk.uncovered.type === "too_many") {
    return Result.ok({ type: "unprovable", reason: "too_many_uncovered" });
  }
  const recounted =
    walk.pages.length === 0
      ? Result.ok([])
      : await readRows(
          tx,
          corpusIndexFlipPageRecountQuery(walk.pair, walk.pages),
          walk.pair,
        );
  if (Result.isError(recounted)) {
    return recounted;
  }
  const moved = recounted.value.map((row) => ({
    after: nullableText(row, "after_id"),
    last: requiredText(row, "last_id"),
    walked: requiredCount(row, "walked"),
    states: requiredCount(row, "states"),
  }));
  if (moved.some(({ walked, states: counted }) => counted < walked)) {
    return Result.ok({ type: "unprovable", reason: "states_removed" });
  }
  const movedStates = moved.reduce(
    (total, { states: counted }) => total + counted,
    0,
  );
  if (movedStates > CORPUS_INDEX_FLIP_RECHECK_MAX) {
    return Result.ok({ type: "unprovable", reason: "too_many_changed" });
  }
  const listed = walk.uncovered.entityIds;
  if (moved.length === 0 && listed.length === 0) {
    return Result.ok({
      type: "read",
      pages: walk.pages.length,
      changedPages: 0,
      reread: 0,
      missing: 0,
      sample: [],
    });
  }
  const rows = await readRows(
    tx,
    corpusIndexFlipBehindCursorQuery(walk.pair, { pages: moved, listed }),
    walk.pair,
  );
  if (Result.isError(rows)) {
    return rows;
  }
  const row = rows.value.at(0);
  if (requiredCount(row, "removed") > 0) {
    return Result.ok({ type: "unprovable", reason: "states_removed" });
  }
  return Result.ok({
    type: "read",
    pages: walk.pages.length,
    changedPages: moved.length,
    reread: requiredCount(row, "reread"),
    missing: requiredCount(row, "missing"),
    sample: entityIdsOf(row, "sample"),
  });
};

/**
 * The walk's coverage with what the decision found missing in the tail and
 * behind the cursor added to it.
 */
const coverageWithDecision = (
  coverage: CorpusIndexFlipCoverage,
  tail: CorpusIndexFlipTail,
  behind: CorpusIndexFlipBehindCursor,
): CorpusIndexFlipCoverage => {
  if (coverage.type !== "complete") {
    return coverage;
  }
  const found = [tail, behind].flatMap((read) =>
    read.type === "read" ? [read] : [],
  );
  return {
    ...coverage,
    walked: coverage.walked + (tail.type === "read" ? tail.walked : 0),
    missing: found.reduce(
      (total, { missing }) => total + missing,
      coverage.missing,
    ),
    sample: [
      ...coverage.sample,
      ...found.flatMap(({ sample }) => sample),
    ].slice(0, CORPUS_INDEX_FLIP_SAMPLE_MAX),
  };
};

/** Why a walk found complete still cannot prove coverage, or null. */
const unprovenCoverage = (
  tail: CorpusIndexFlipTail,
  behind: CorpusIndexFlipBehindCursor,
): Extract<CorpusIndexFlipVerdict, { type: "undecided" }>["reason"] | null => {
  if (tail.type === "too_long") {
    return "coverage_tail_long";
  }
  return behind.type === "unprovable" ? behind.reason : null;
};

/**
 * The second half: decide the verdict from a walk, in `tx`. A flip calls it
 * under the exclusive projection fence, so nothing it reads can change before
 * the flip commits; the module comment says why the walk's result holds there
 * too. It re-reads the pair and refuses one that moved (`serving_changed`,
 * `generation_changed`), reads every serving state after the walk's last one
 * (the tail), what changed behind the walk's cursor, then the regression
 * statement.
 */
export const decideCorpusIndexFlipParityTx = async (
  tx: Transaction,
  walk: CorpusIndexFlipCoverageWalk,
  { exemptMinutes }: { exemptMinutes: number },
): Promise<Result<CorpusIndexFlipParity, CorpusIndexFlipParityError>> => {
  requireValidOptions(exemptMinutes, null);
  const { family, candidate } = walk.pair;
  const again = await readComparablePairTx(tx, { family, candidate });
  if (Result.isError(again)) {
    return Result.err(again.error);
  }
  if (again.value.serving !== walk.pair.serving) {
    return refused(
      `${family} changed its serving generation during the read`,
      "serving_changed",
    );
  }
  if (
    again.value.servingUpdatedAtUs !== walk.pair.servingUpdatedAtUs ||
    again.value.candidateUpdatedAtUs !== walk.pair.candidateUpdatedAtUs
  ) {
    return refused(
      `${family}/${walk.pair.serving} or ${family}/${candidate} changed its registration during the read`,
      "generation_changed",
    );
  }
  if (
    corpusIndexFlipUnmovedJurisdictions(again.value).join(",") !==
    corpusIndexFlipUnmovedJurisdictions(walk.pair).join(",")
  ) {
    return refused(
      `The jurisdictions ${family} keeps where they are changed during the read`,
      "jurisdiction_serving_pointer",
    );
  }
  const tail = await readTailTx(tx, walk);
  if (Result.isError(tail)) {
    return tail;
  }
  const behind = await readBehindCursorTx(tx, walk);
  if (Result.isError(behind)) {
    return behind;
  }
  const watermark = await readWatermarkTx(tx, exemptMinutes);
  const regressions = await readRegressionsTx(tx, again.value, watermark);
  if (Result.isError(regressions)) {
    return regressions;
  }
  const coverage = coverageWithDecision(
    walk.coverage,
    tail.value,
    behind.value,
  );
  const verdict = verdictOf(coverage, regressions.value);
  const unproven =
    verdict.type === "no_regression"
      ? unprovenCoverage(tail.value, behind.value)
      : null;
  return Result.ok({
    pair: walk.pair,
    watermark,
    coverage,
    tail: tail.value,
    behindCursor: behind.value,
    regressions: regressions.value,
    verdict:
      unproven === null
        ? verdict
        : {
            type: "undecided",
            reason: unproven,
            knownMissing: 0,
            knownRegressions: 0,
          },
  });
};

/**
 * What a flip of `candidate` would lose against the family's serving
 * generation, read without a fence: the walk, then the decision in one more
 * transaction. `runInTransaction` should open read-only transactions.
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
  requireValidOptions(exemptMinutes, coverage);
  const walk = await walkCorpusIndexFlipCoverage({
    runInTransaction,
    family,
    candidate,
    coverage,
  });
  if (Result.isError(walk)) {
    return walk;
  }
  return await readInTransaction(
    runInTransaction,
    async (tx) =>
      await decideCorpusIndexFlipParityTx(tx, walk.value, { exemptMinutes }),
  );
};
