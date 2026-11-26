/**
 * The durable readiness proof of one route (physical index) of a corpus
 * generation: one row per route in `corpus_index_route_proofs`.
 *
 * What a proof says. A clean pass walked the route's applied revisions and
 * found each in the engine with its exact document count, then its settled
 * and withdrawn revisions and found none, each at the instant its page was
 * read, all on one engine incarnation of the index: the one the pass read
 * first and read again at its end. It is a sweep, not a snapshot: a loss
 * after a page was read stays unseen until a later pass reads that key, and
 * documents PostgreSQL does not know are never looked for. The flip re-reads
 * the incarnation under its fence (`checkCorpusIndexRouteProofIncarnations`).
 *
 * Why a pass never restarts under inflow. Every move into applied, settled or
 * withdrawn carries its own exact engine observation: applied only on a
 * branded presence proof, settled only on a branded settlement proof,
 * withdrawn only on an empty census after the indexer's kill deadline. So a
 * revision that enters a walked set during the pass, behind the cursor or
 * ahead of it, was checked by its own transition, and one that leaves a set
 * only removes an obligation. Key order plays no part. A writer that adds
 * rows to these sets without such an observation must revoke the route here.
 *
 * Why a pass too old to prove does restart. A proof counts only while its
 * pass STARTED within `CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS`, so an open
 * pass that started longer ago can only end in a proof that is already
 * expired. The page that picks such a pass up starts it over from the
 * beginning instead of resuming it (`pass_too_old_to_prove`), judged on the
 * database clock by the same predicate the reader's freshness uses. The
 * restart is not a revocation: the route's last proof, older still, keeps
 * reading `expired`, and what a proof certifies is unchanged.
 *
 * Who may walk a route. Only a route the generation's manifest declares, and
 * only while its group is attested (a group the generation was created with
 * is attested by the manifest itself): every pass transaction re-reads that,
 * and a withdrawal or a new attestation revokes the proof in its own
 * transaction, so a proof is always younger than the attestation it rests on.
 *
 * Cost under continuous inflow. Ordinary projection writes never touch the
 * table. A census page costs a few primary-key reads and one primary-key
 * update here, beside the census page itself.
 *
 * How a pass is split. Its first page lays the route's keys out in
 * `CorpusIndexRouteCensusRange`s, disjoint and together covering every key:
 * each range has its own bounds in both phases (entity ids for `present`,
 * revision ids for `absent`), its own cursor, and walks both phases on its
 * own. The ranges live in the pass's row (`pass_ranges`), bound to the pass
 * id, so the pass and all its ranges move in one row write: a revocation or
 * a restart starts every range over at once, and the page that ends the last
 * range writes the proof in the same row. The proof holds only when every
 * range of the same pass ended both phases on the pass's one incarnation,
 * and its start is the earliest start of its ranges. The argument above holds
 * per range: a revision entering a walked set carried its own observation,
 * wherever its key falls. Range bounds only spread the work; no key is
 * outside every range, so how evenly they split it never changes the proof.
 *
 * Every write is a compare-and-set on the row's own pass identity (number,
 * id, incarnation) and, for a page, on its range's phase and cursor, so two
 * runners walking one range never both advance it, two runners picking up
 * one pass too old to prove restart it once, and a revocation that lands
 * while a page is read, or while a pass is restarted, wins.
 */
import { panic, Result } from "better-result";
import { and, eq, type SQL, sql } from "drizzle-orm";

import { isUuid } from "@stll/uuid-codec";

import {
  corpusIndexGenerations,
  corpusIndexGroupEnrollments,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  corpusIndexRouteProofs,
} from "@/api/db/schema";
import type { Transaction } from "@/api/db/types";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type {
  CorpusIndexClient,
  CorpusIndexError,
  CorpusIndexIncarnation,
} from "@/api/lib/legal-search/corpus-index-client";
import { requireRegisteredCorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  caseLawManifestGroups,
  registeredCorpusIndexGroups,
  resolveCorpusIndexGroupContract,
} from "@/api/lib/legal-search/corpus-index-group-contract";
import type { CorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  CORPUS_INDEX_ROUTE_CENSUS_EXPECTATIONS,
  CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS,
  CORPUS_INDEX_ROUTE_PROOF_RANGE_MIN_ROWS,
  CORPUS_INDEX_ROUTE_PROOF_RANGES_MAX,
  CORPUS_INDEX_ROUTE_PROOF_REVOKE_REASONS,
  type CorpusIndexRouteCensusExpectation,
  type CorpusIndexRoutePassRestartReason,
  type CorpusIndexRouteProofRevokeReason,
} from "@/api/lib/legal-search/corpus-index-route-proof-contract";
import { isRecord } from "@/api/lib/type-guards";

export type CorpusIndexRoute = {
  family: CorpusFamily;
  generation: string;
  indexId: string;
};

/** The keys one range walks in one phase: after `after`, up to `upto`; null is open. */
type CorpusIndexRouteRangeBounds = {
  after: string | null;
  upto: string | null;
};

/**
 * One key range of a route's census pass, walked by its own cursor through
 * both phases. `index` is its place among the pass's ranges, in key order.
 * `through` is the last key its current phase walks, taken when the phase
 * began and never past `upto`; null when the phase has nothing to walk.
 * `completed` is true once it walked `absent` to its end.
 */
export type CorpusIndexRouteCensusRange = {
  index: number;
  bounds: Record<
    CorpusIndexRouteCensusExpectation,
    CorpusIndexRouteRangeBounds
  >;
  startedAt: string;
  expectation: CorpusIndexRouteCensusExpectation;
  cursor: string | null;
  through: string | null;
  inspected: number;
  completed: boolean;
};

/**
 * Where a route's census pass stands. `number` orders passes and `id`
 * identifies one, so a page read for a pass never matches another. The start
 * is in epoch microseconds, PostgreSQL's precision: the earliest start of the
 * pass's ranges, or the instant the pass was begun while it has none yet.
 * `incarnation` is the engine index the pass read first, null before that.
 * `elapsedMs` is the pass's age when the row was read, on the database clock
 * its start was taken on. `ranges` are its ranges, null until its first page
 * lays them out; `inspected` sums what they walked. `lastProof` is the
 * route's last clean pass, null before one completes: its number tells how
 * many passes have restarted since, its count how far the pass under way has
 * to go.
 */
export type CorpusIndexRouteCensusPass = {
  number: number;
  id: string;
  startedAtUs: string;
  incarnation: string | null;
  elapsedMs: number;
  inspected: number;
  ranges: CorpusIndexRouteCensusRange[] | null;
  lastProof: { number: number; inspected: number } | null;
};

const proofs = corpusIndexRouteProofs;
const states = corpusIndexProjectionStates;
const intents = corpusIndexProjectionIntents;
const enrollments = corpusIndexGroupEnrollments;

const epochMicros = (instant: SQL): SQL =>
  sql`(extract(epoch FROM ${instant}) * 1000000)::bigint`;

/**
 * Whether a pass that started at `startedAt` is young enough for its proof to
 * count, on the database clock: the one rule behind both the reader's
 * freshness and the restart of a pass too old to prove.
 */
const startedWithinMaxAge = (
  startedAt: SQL,
  maxAgeHours: number = CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS,
): SQL =>
  sql`${startedAt} >= clock_timestamp()
    - make_interval(secs => ${Math.round(maxAgeHours * 3600)})`;

const isRoute = ({ family, generation, indexId }: CorpusIndexRoute): SQL =>
  sql`${proofs.family} = ${family}
    AND ${proofs.generation} = ${generation}
    AND ${proofs.indexId} = ${indexId}`;

const OPEN_BOUNDS: CorpusIndexRouteRangeBounds = { after: null, upto: null };

/** The keys of `column` within `bounds`, as a condition. */
const withinBounds = (
  column: SQL,
  { after, upto }: CorpusIndexRouteRangeBounds,
): SQL =>
  sql`${after === null ? sql`true` : sql`${column} > ${after}::uuid`}
    AND ${upto === null ? sql`true` : sql`${column} <= ${upto}::uuid`}`;

/**
 * The first or last applied revision's entity on the route within `bounds`.
 * The last one is what the `present` phase of a range walks through: the
 * largest key of the applied-census index in the range when the phase begins.
 * The bound only lets the phase end under inflow; what is applied later, at
 * any key, carried its own presence proof.
 */
const appliedEdge = (
  { family, generation, indexId }: CorpusIndexRoute,
  edge: "first" | "last",
  bounds: CorpusIndexRouteRangeBounds = OPEN_BOUNDS,
) =>
  sql`(
    SELECT ${states.entityId}
    FROM ${states}
    WHERE ${states.family} = ${family}
      AND ${states.generation} = ${generation}
      AND ${states.appliedIndexId} = ${indexId}
      AND ${states.appliedAction} = 'upsert'
      AND ${states.appliedRevision} IS NOT NULL
      AND ${withinBounds(sql`${states.entityId}`, bounds)}
    ORDER BY ${states.entityId} ${sql.raw(edge === "first" ? "ASC" : "DESC")}
    LIMIT 1
  )`;

const presentThrough = (
  route: CorpusIndexRoute,
  bounds: CorpusIndexRouteRangeBounds = OPEN_BOUNDS,
) => appliedEdge(route, "last", bounds);

/**
 * The first or last deleted revision on the route within `bounds`: the
 * smaller, or the larger, of the first or last settled and withdrawn
 * revision id. The last one is what the `absent` phase of a range walks
 * through; as for `presentThrough`, a revision settled or withdrawn later
 * carried its own observation of absence.
 */
const deletedEdge = (
  { family, generation, indexId }: CorpusIndexRoute,
  edge: "first" | "last",
  bounds: CorpusIndexRouteRangeBounds = OPEN_BOUNDS,
) => {
  const order = sql.raw(edge === "first" ? "ASC" : "DESC");
  const extreme = (status: "settled" | "withdrawn") => sql`(
      SELECT ${intents.id} AS id
      FROM ${intents}
      WHERE ${intents.family} = ${family}
        AND ${intents.generation} = ${generation}
        AND ${intents.indexId} = ${indexId}
        AND ${intents.status} = ${sql.raw(`'${status}'`)}
        AND ${withinBounds(sql`${intents.id}`, bounds)}
      ORDER BY ${intents.id} ${order}
      LIMIT 1
    )`;
  return sql`(
    SELECT deleted.id
    FROM (${extreme("settled")} UNION ALL ${extreme("withdrawn")}) AS deleted
    ORDER BY deleted.id ${order}
    LIMIT 1
  )`;
};

const absentThrough = (
  route: CorpusIndexRoute,
  bounds: CorpusIndexRouteRangeBounds = OPEN_BOUNDS,
) => deletedEdge(route, "last", bounds);

/** The bound a range's phase walks through, taken when the phase begins. */
const phaseThrough = (
  route: CorpusIndexRoute,
  expectation: CorpusIndexRouteCensusExpectation,
  bounds: CorpusIndexRouteRangeBounds,
) =>
  expectation === "present"
    ? presentThrough(route, bounds)
    : absentThrough(route, bounds);

/**
 * The ranges of the row's pass under way, or null when none are laid out for
 * it: a range set bound to another pass id belongs to a pass that ended.
 */
const currentRanges = sql`CASE
    WHEN ${proofs.passRanges} ->> 'passId' = ${proofs.passId}::text
    THEN ${proofs.passRanges} -> 'ranges'
  END`;

/**
 * The start of the row's pass under way: the earliest start of its ranges,
 * since a pass observes nothing before they are laid out, or the instant it
 * was begun while it has none.
 */
const passStart = sql`COALESCE(
    (
      SELECT min((laid.value ->> 'startedAt')::timestamptz)
      FROM jsonb_array_elements(${currentRanges}) AS laid(value)
    ),
    ${proofs.passStartedAt}
  )`;

/**
 * Revisions the pass under way has found as recorded: what its single cursor
 * walked before the pass was split (`carried`), and what every range walked.
 */
const passInspected = sql`((
    SELECT COALESCE(sum((laid.value ->> 'inspected')::bigint), 0)
    FROM jsonb_array_elements(${currentRanges}) AS laid(value)
  ) + COALESCE(
    CASE
      WHEN ${proofs.passRanges} ->> 'passId' = ${proofs.passId}::text
      THEN (${proofs.passRanges} ->> 'carried')::bigint
    END,
    0
  ))`;

const requiredText = (row: unknown, key: string): string =>
  isRecord(row) && typeof row[key] === "string"
    ? row[key]
    : panic(`Malformed route proof row: ${key}`);

const nullableText = (row: unknown, key: string): string | null => {
  if (!isRecord(row)) {
    return panic(`Malformed route proof row: ${key}`);
  }
  const value = row[key];
  if (value === null) {
    return null;
  }
  return typeof value === "string"
    ? value
    : panic(`Malformed route proof row: ${key}`);
};

const requiredCount = (row: unknown, key: string): number => {
  const value = isRecord(row) ? row[key] : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : panic(`Malformed route proof row: ${key}`);
};

const requiredMilliseconds = (row: unknown, key: string): number => {
  const value = isRecord(row) ? row[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : panic(`Malformed route proof row: ${key}`);
};

const censusExpectation = (value: string): CorpusIndexRouteCensusExpectation =>
  CORPUS_INDEX_ROUTE_CENSUS_EXPECTATIONS.find(
    (expectation) => expectation === value,
  ) ?? panic(`Unknown route census expectation: ${value}`);

const revokeReason = (value: string): CorpusIndexRouteProofRevokeReason =>
  CORPUS_INDEX_ROUTE_PROOF_REVOKE_REASONS.find((reason) => reason === value) ??
  panic(`Unknown route proof revoke reason: ${value}`);

/** The pass columns, as every read of a proof row selects them. */
const passColumns = sql`${proofs.passNumber}::int AS pass_number,
  ${proofs.passId}::text AS pass_id,
  ${epochMicros(passStart)}::text AS started_at_us,
  ${proofs.passIndexIncarnation} AS incarnation,
  floor(extract(epoch FROM clock_timestamp() - ${passStart}) * 1000)::float8
    AS elapsed_ms,
  ${passInspected}::int AS inspected,
  (${currentRanges})::text AS ranges,
  ${proofs.provenPassNumber}::int AS last_proof_number,
  ${proofs.provenInspected}::int AS last_proof_inspected`;

const MALFORMED_RANGES = "Malformed route proof ranges";

const rangeKey = (value: unknown): string | null => {
  if (value === null) {
    return null;
  }
  return typeof value === "string" && isUuid(value)
    ? value
    : panic(MALFORMED_RANGES);
};

const rangeOf = (
  value: unknown,
  index: number,
): CorpusIndexRouteCensusRange => {
  if (!isRecord(value)) {
    return panic(MALFORMED_RANGES);
  }
  const { inspected, completed, startedAt, expectation } = value;
  if (
    typeof inspected !== "number" ||
    !Number.isSafeInteger(inspected) ||
    inspected < 0 ||
    typeof completed !== "boolean" ||
    typeof startedAt !== "string" ||
    typeof expectation !== "string"
  ) {
    return panic(MALFORMED_RANGES);
  }
  return {
    index,
    bounds: {
      present: {
        after: rangeKey(value["presentAfter"]),
        upto: rangeKey(value["presentUpto"]),
      },
      absent: {
        after: rangeKey(value["absentAfter"]),
        upto: rangeKey(value["absentUpto"]),
      },
    },
    startedAt,
    expectation: censusExpectation(expectation),
    cursor: rangeKey(value["cursor"]),
    through: rangeKey(value["through"]),
    inspected,
    completed,
  };
};

const rangesOf = (
  text: string | null,
): CorpusIndexRouteCensusRange[] | null => {
  if (text === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(text);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > CORPUS_INDEX_ROUTE_PROOF_RANGES_MAX
  ) {
    return panic(MALFORMED_RANGES);
  }
  return parsed.map(rangeOf);
};

const passOf = (row: unknown): CorpusIndexRouteCensusPass => {
  const lastProofNumber = isRecord(row) ? row["last_proof_number"] : undefined;
  return {
    number: requiredCount(row, "pass_number"),
    id: requiredText(row, "pass_id"),
    startedAtUs: requiredText(row, "started_at_us"),
    incarnation: nullableText(row, "incarnation"),
    elapsedMs: requiredMilliseconds(row, "elapsed_ms"),
    inspected: requiredCount(row, "inspected"),
    ranges: rangesOf(nullableText(row, "ranges")),
    lastProof:
      lastProofNumber === null
        ? null
        : {
            number: requiredCount(row, "last_proof_number"),
            inspected: requiredCount(row, "last_proof_inspected"),
          },
  };
};

/**
 * The one writer of route proofs. A proof is bookkeeping derived from the
 * public corpus projection and the engine, rewritten on every census page, so
 * no write of it is an audited action; the changes that revoke it record
 * their own outcome.
 */
const writeRouteProofTx = async (
  tx: Transaction,
  statement: SQL,
): Promise<unknown[]> =>
  // audit: skip - derived public corpus projection bookkeeping
  executedRows(await tx.execute(statement));

/**
 * Revoke the route's proof and restart its pass at the same instant, so only
 * a pass started after this change proves the route again. Called in the
 * transaction of the change that voids the proof (a drift repair, another
 * engine incarnation, a withdrawal or a new attestation), after that change's
 * own row locks: the proof row is always the last lock such a transaction
 * takes. An upsert: a route no pass has reached yet gets a row that already
 * carries the revocation, so a pass whose first write commits later still
 * starts after it.
 */
export const revokeCorpusIndexRouteProofTx = async (
  tx: Transaction,
  route: CorpusIndexRoute,
  reason: CorpusIndexRouteProofRevokeReason,
  { incarnation = null }: { incarnation?: string | null } = {},
): Promise<void> => {
  await writeRouteProofTx(
    tx,
    sql`
    INSERT INTO ${proofs} AS proof
      (family, generation, index_id, pass_started_at, pass_expectation,
       pass_through, pass_index_incarnation, revoked_at, revoke_reason,
       revoked_pass_number, updated_at)
    SELECT ${route.family}, ${route.generation}, ${route.indexId},
      clock_reading.at, 'present', ${presentThrough(route)}, ${incarnation},
      clock_reading.at, ${reason}, 1, clock_reading.at
    FROM (SELECT clock_timestamp() AS at) AS clock_reading
    ON CONFLICT ON CONSTRAINT corpus_index_route_proofs_pkey DO UPDATE
    SET revoked_at = EXCLUDED.revoked_at,
      revoke_reason = EXCLUDED.revoke_reason,
      revoked_pass_number = proof.pass_number + 1,
      pass_number = proof.pass_number + 1,
      pass_id = gen_random_uuid(),
      pass_started_at = EXCLUDED.pass_started_at,
      pass_through = EXCLUDED.pass_through,
      pass_expectation = 'present',
      pass_cursor = NULL,
      pass_inspected = 0,
      pass_index_incarnation = EXCLUDED.pass_index_incarnation,
      pass_ranges = NULL,
      updated_at = EXCLUDED.updated_at
  `,
  );
};

/** How the route's group earns the right to be walked. */
type RouteGate =
  /** A group the generation was created with: the manifest attests it. */
  | { type: "manifest" }
  /** A registered group: attested only by its enrollment row. */
  | { type: "enrollment"; indexGroup: string; effectiveDigest: string };

type DeclaredRoute = { indexId: string; gate: RouteGate };

/**
 * Every route the manifest declares, or null when its routing is open (one
 * index per jurisdiction, any jurisdiction), so the code cannot name them.
 */
const declaredRoutes = (
  manifest: CorpusIndexManifest,
): DeclaredRoute[] | null => {
  if (manifest.family !== "case_law") {
    return null;
  }
  const registered = new Map(
    registeredCorpusIndexGroups(manifest).map((group) => [
      group.indexGroup,
      group,
    ]),
  );
  return caseLawManifestGroups(manifest).map((indexGroup) => {
    const { indexId } = resolveCorpusIndexGroupContract({
      manifest,
      indexGroup,
    });
    const group = registered.get(indexGroup);
    return {
      indexId,
      gate:
        group === undefined
          ? { type: "manifest" }
          : {
              type: "enrollment",
              indexGroup,
              effectiveDigest: group.effectiveDigest,
            },
    };
  });
};

/** Why a route cannot be walked, or proven, now. */
export type CorpusIndexRouteRefusal =
  | { type: "generation_absent" }
  /** The manifest routes per jurisdiction; it declares no closed route set. */
  | { type: "open_route_set" }
  | { type: "undeclared_route" }
  | {
      type: "unattested";
      reason: "unbound" | "pending" | "contract_mismatch";
    };

type Admission =
  | { type: "admitted"; gate: RouteGate }
  | { type: "refused"; refusal: CorpusIndexRouteRefusal };

const readRegisteredManifestTx = async (
  tx: Transaction,
  { family, generation }: Pick<CorpusIndexRoute, "family" | "generation">,
): Promise<CorpusIndexManifest | null> => {
  const row = (
    await tx
      .select()
      .from(corpusIndexGenerations)
      .where(
        and(
          eq(corpusIndexGenerations.family, family),
          eq(corpusIndexGenerations.generation, generation),
        ),
      )
      .limit(1)
  ).at(0);
  return row === undefined ? null : requireRegisteredCorpusIndexManifest(row);
};

type EnrollmentReading = {
  indexGroup: string;
  provisioningStatus: string;
  effectiveDigest: string;
};

const enrollmentKey = (
  { family, generation }: Pick<CorpusIndexRoute, "family" | "generation">,
  indexGroups: readonly string[],
) => sql`${enrollments.family} = ${family}
  AND ${enrollments.generation} = ${generation}
  AND ${enrollments.indexGroup} IN (${sql.join(
    indexGroups.map((group) => sql`${group}`),
    sql`, `,
  )})`;

const readEnrollmentsTx = async (
  tx: Transaction,
  route: Pick<CorpusIndexRoute, "family" | "generation">,
  indexGroups: readonly string[],
): Promise<Map<string, EnrollmentReading>> => {
  if (indexGroups.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({
      indexGroup: enrollments.indexGroup,
      provisioningStatus: enrollments.provisioningStatus,
      effectiveDigest: enrollments.effectiveDigest,
    })
    .from(enrollments)
    .where(enrollmentKey(route, indexGroups))
    .orderBy(enrollments.indexGroup)
    .limit(indexGroups.length);
  return new Map(rows.map((row) => [row.indexGroup, row]));
};

/** Whether an enrollment attests its group's declared contract now. */
const enrollmentGate = (
  gate: Extract<RouteGate, { type: "enrollment" }>,
  row: EnrollmentReading | undefined,
):
  | { type: "attested" }
  | Extract<CorpusIndexRouteRefusal, { type: "unattested" }> => {
  if (row === undefined) {
    return { type: "unattested", reason: "unbound" };
  }
  if (row.effectiveDigest !== gate.effectiveDigest) {
    return { type: "unattested", reason: "contract_mismatch" };
  }
  return row.provisioningStatus === "attested"
    ? { type: "attested" }
    : { type: "unattested", reason: "pending" };
};

/**
 * May this route be walked now? No lock is needed to keep the answer true
 * until the page is recorded: a withdrawal, a new attestation and a rebuild
 * each change the proof row in their own transaction (revocation or cascade),
 * so whichever commits second, the page's compare-and-set or the change,
 * leaves the proof revoked or gone.
 */
const admitRouteTx = async (
  tx: Transaction,
  route: CorpusIndexRoute,
): Promise<Admission> => {
  const manifest = await readRegisteredManifestTx(tx, route);
  if (manifest === null) {
    return { type: "refused", refusal: { type: "generation_absent" } };
  }
  const routes = declaredRoutes(manifest);
  if (routes === null) {
    return { type: "refused", refusal: { type: "open_route_set" } };
  }
  const declared = routes.find(({ indexId }) => indexId === route.indexId);
  if (declared === undefined) {
    return { type: "refused", refusal: { type: "undeclared_route" } };
  }
  const { gate } = declared;
  if (gate.type === "manifest") {
    return { type: "admitted", gate };
  }
  const enrollment = (
    await readEnrollmentsTx(tx, route, [gate.indexGroup])
  ).get(gate.indexGroup);
  const attested = enrollmentGate(gate, enrollment);
  return attested.type === "attested"
    ? { type: "admitted", gate }
    : { type: "refused", refusal: attested };
};

/** An open pass given up for a new one, and why. */
export type CorpusIndexRoutePassRestart = {
  reason: CorpusIndexRoutePassRestartReason;
  /** The pass given up: its number, rows walked, and age on the database clock. */
  abandoned: { number: number; inspected: number; elapsedMs: number };
};

/** What starting a census page found. */
export type CorpusIndexRouteCensusStart =
  | {
      type: "pass";
      pass: CorpusIndexRouteCensusPass;
      /** The range this page walks, its phase's bound taken. */
      range: CorpusIndexRouteCensusRange;
      /**
       * Whether PostgreSQL records nothing applied on the whole route: read
       * only for a range whose `present` phase has nothing to walk, false
       * otherwise.
       */
      routeHoldsNothing: boolean;
      /** The open pass this page started over instead of resuming. */
      restarted: CorpusIndexRoutePassRestart | null;
    }
  /**
   * The range asked for has nothing to walk in the pass under way: it ended
   * both phases, the pass has fewer ranges, or the pass moved while its
   * ranges were laid out. Nothing was walked; `pass` is the pass as read.
   */
  | {
      type: "range_idle";
      pass: CorpusIndexRouteCensusPass;
      restarted: CorpusIndexRoutePassRestart | null;
    }
  | { type: "refused"; refusal: CorpusIndexRouteRefusal }
  /** The engine holds no index under the route's id. */
  | { type: "index_missing" };

/**
 * Which range a page walks, and how many ranges a pass this page lays out may
 * have at most. One range is the whole route walked by a single cursor.
 */
export type CorpusIndexRouteCensusPageRequest = {
  range: number;
  ranges: number;
};

const SINGLE_RANGE: CorpusIndexRouteCensusPageRequest = { range: 0, ranges: 1 };

/**
 * Start the route's open pass over from its beginning, on the incarnation the
 * page read, without touching its proof. A compare-and-set on the pass's
 * number and id, with the age re-judged at the write: null when another
 * runner or a revocation moved the pass first, which then stands.
 */
const restartPassTooOldToProveTx = async (
  tx: Transaction,
  route: CorpusIndexRoute,
  pass: CorpusIndexRouteCensusPass,
  incarnation: string,
): Promise<CorpusIndexRoutePassRestart | null> => {
  const restarted = await writeRouteProofTx(
    tx,
    sql`
    UPDATE ${proofs}
    SET pass_number = ${proofs.passNumber} + 1,
      pass_id = gen_random_uuid(),
      pass_started_at = clock_reading.at,
      pass_through = ${presentThrough(route)},
      pass_expectation = 'present',
      pass_cursor = NULL,
      pass_inspected = 0,
      pass_index_incarnation = ${incarnation},
      pass_ranges = NULL,
      updated_at = clock_reading.at
    FROM (SELECT clock_timestamp() AS at) AS clock_reading
    WHERE ${isRoute(route)}
      AND ${proofs.passNumber} = ${pass.number}
      AND ${proofs.passId} = ${pass.id}::uuid
      AND NOT ${startedWithinMaxAge(passStart)}
    RETURNING ${proofs.indexId}
  `,
  );
  return restarted.length === 1
    ? {
        reason: "pass_too_old_to_prove",
        abandoned: {
          number: pass.number,
          inspected: pass.inspected,
          elapsedMs: pass.elapsedMs,
        },
      }
    : null;
};

const UUID_SPACE_END = 2n ** 128n - 1n;

const uuidValue = (uuid: string): bigint =>
  BigInt(`0x${uuid.replaceAll("-", "")}`);

const uuidOfValue = (value: bigint): string => {
  const hex = value.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * `count` disjoint key ranges, in key order, that together hold every key:
 * the first is open below, the last open above, and the inner bounds are
 * spread evenly between the first and the last key the phase holds now (over
 * the whole key space while it holds fewer than two). How evenly they split
 * the keys only spreads the work: inflow lands in whichever range holds its
 * key, and every key is in exactly one.
 */
const splitCorpusIndexRouteKeys = (
  first: string | null,
  last: string | null,
  count: number,
  /** Keys up to this one were walked already: the first range starts after it. */
  after: string | null = null,
): CorpusIndexRouteRangeBounds[] => {
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > CORPUS_INDEX_ROUTE_PROOF_RANGES_MAX
  ) {
    return panic(`Route proof range count out of bounds: ${count}`);
  }
  const floor = after === null ? null : uuidValue(after);
  const low = floor ?? (first === null ? null : uuidValue(first));
  const high = last === null ? null : uuidValue(last);
  const [from, to] = ((): [bigint, bigint] => {
    if (low !== null && high !== null && low < high) {
      return [low, high];
    }
    return [floor ?? 0n, UUID_SPACE_END];
  })();
  const inner = Array.from({ length: count - 1 }, (_, position) =>
    uuidOfValue(from + ((to - from) * BigInt(position + 1)) / BigInt(count)),
  );
  return Array.from({ length: count }, (_, position) => ({
    after: position === 0 ? after : (inner[position - 1] ?? null),
    upto: position === count - 1 ? null : (inner[position] ?? null),
  }));
};

/**
 * How many ranges a new pass is split into: one on a route that records
 * nothing, at most `requested`, and no more than its last clean pass's
 * revisions fill at `CORPUS_INDEX_ROUTE_PROOF_RANGE_MIN_ROWS` each.
 */
const rangeCount = ({
  requested,
  lastProof,
  holdsNothing,
}: {
  requested: number;
  lastProof: CorpusIndexRouteCensusPass["lastProof"];
  holdsNothing: boolean;
}): number => {
  if (holdsNothing) {
    return 1;
  }
  if (lastProof === null) {
    return requested;
  }
  return Math.min(
    requested,
    Math.max(
      1,
      Math.ceil(lastProof.inspected / CORPUS_INDEX_ROUTE_PROOF_RANGE_MIN_ROWS),
    ),
  );
};

/** Read the route's pass row; it exists once the page's start inserted it. */
const readPassTx = async (
  tx: Transaction,
  route: CorpusIndexRoute,
): Promise<{ pass: CorpusIndexRouteCensusPass; tooOldToProve: boolean }> => {
  const row =
    executedRows(
      await tx.execute(sql`
        SELECT ${passColumns},
          NOT ${startedWithinMaxAge(passStart)} AS too_old_to_prove
        FROM ${proofs}
        WHERE ${isRoute(route)}
      `),
    ).at(0) ?? panic(`Route proof row was lost: ${route.indexId}`);
  return {
    pass: passOf(row),
    tooOldToProve: isRecord(row) && row["too_old_to_prove"] === true,
  };
};

/**
 * Lay the pass's keys out in ranges, each starting at this instant in its
 * `present` phase. A compare-and-set on the pass with no ranges yet: when
 * another runner laid them out first, or the pass moved, theirs stand.
 *
 * A pass a single cursor began walking (`pass_cursor`, `pass_expectation`)
 * keeps that walk: only the keys after its cursor in its phase are laid out,
 * the ranges start where the pass began and carry what it walked. That is
 * the same proof the single cursor would have ended: the keys up to its
 * cursor were read during this pass, on the incarnation the pass is bound to
 * (a page that reads another revokes the pass before it lays anything out),
 * and a revision entering a walked set since carried its own observation.
 */
const layOutRangesTx = async (
  tx: Transaction,
  route: CorpusIndexRoute,
  pass: CorpusIndexRouteCensusPass,
  requested: number,
): Promise<void> => {
  const edges =
    executedRows(
      await tx.execute(sql`
        SELECT ${appliedEdge(route, "first")}::text AS present_first,
          ${appliedEdge(route, "last")}::text AS present_last,
          ${deletedEdge(route, "first")}::text AS absent_first,
          ${deletedEdge(route, "last")}::text AS absent_last,
          ${proofs.passExpectation} AS walked_expectation,
          ${proofs.passCursor}::text AS walked_cursor,
          ${proofs.passInspected}::int AS walked_inspected
        FROM ${proofs}
        WHERE ${isRoute(route)}
      `),
    ).at(0) ?? panic(`Route proof row was lost: ${route.indexId}`);
  const presentFirst = nullableText(edges, "present_first");
  const absentFirst = nullableText(edges, "absent_first");
  // What a single cursor walked of this pass before it was split; a pass
  // begun split, or not walked yet, holds the cursor at its start.
  const walked = {
    expectation: censusExpectation(requiredText(edges, "walked_expectation")),
    cursor: nullableText(edges, "walked_cursor"),
    inspected: requiredCount(edges, "walked_inspected"),
  };
  const carried = walked.cursor !== null || walked.expectation === "absent";
  const count = rangeCount({
    requested,
    lastProof: pass.lastProof,
    holdsNothing: presentFirst === null && absentFirst === null,
  });
  const present = splitCorpusIndexRouteKeys(
    presentFirst,
    nullableText(edges, "present_last"),
    count,
    carried && walked.expectation === "present" ? walked.cursor : null,
  );
  const absent = splitCorpusIndexRouteKeys(
    absentFirst,
    nullableText(edges, "absent_last"),
    count,
    carried && walked.expectation === "absent" ? walked.cursor : null,
  );
  const layout = present.map((presentBounds, position) => {
    const absentBounds = absent[position] ?? panic("Lost a range's bounds");
    return {
      presentAfter: presentBounds.after,
      presentUpto: presentBounds.upto,
      absentAfter: absentBounds.after,
      absentUpto: absentBounds.upto,
      expectation: carried ? walked.expectation : "present",
      cursor: null,
      through: null,
      inspected: 0,
      completed: false,
    };
  });
  await writeRouteProofTx(
    tx,
    sql`
    UPDATE ${proofs}
    SET pass_ranges = jsonb_build_object(
        'passId', ${proofs.passId}::text,
        'carried', ${carried ? walked.inspected : 0}::bigint,
        'ranges', (
          SELECT jsonb_agg(
            laid.value || jsonb_build_object(
              'startedAt',
              ${carried ? sql`${proofs.passStartedAt}` : sql`clock_reading.at`}
            )
            ORDER BY laid.position
          )
          FROM jsonb_array_elements(${JSON.stringify(layout)}::text::jsonb)
            WITH ORDINALITY AS laid(value, position)
        )
      ),
      updated_at = clock_reading.at
    FROM (SELECT clock_timestamp() AS at) AS clock_reading
    WHERE ${isRoute(route)}
      AND ${proofs.passNumber} = ${pass.number}
      AND ${proofs.passId} = ${pass.id}::uuid
      AND ${currentRanges} IS NULL
  `,
  );
};

/** One range of the row's pass, as stored. */
const rangeAt = (index: number): SQL =>
  sql`(${proofs.passRanges} -> 'ranges' -> ${index}::int)`;

/** The row's ranges with `fields` merged into the one at `index`. */
const withRange = (index: number, fields: SQL): SQL =>
  sql`jsonb_set(
    ${proofs.passRanges},
    ARRAY['ranges', ${String(index)}::text],
    ${rangeAt(index)} || ${fields}
  )`;

/**
 * The row still holds the pass and the range exactly as the page read them:
 * the same pass, on `incarnation`, the range in the same phase at the same
 * cursor and not ended.
 */
const rangeIs = (
  route: CorpusIndexRoute,
  pass: CorpusIndexRouteCensusPass,
  range: CorpusIndexRouteCensusRange,
  incarnation: string,
): SQL =>
  sql`${isRoute(route)}
    AND ${proofs.passNumber} = ${pass.number}
    AND ${proofs.passId} = ${pass.id}::uuid
    AND ${proofs.passIndexIncarnation} = ${incarnation}
    AND ${proofs.passRanges} ->> 'passId' = ${pass.id}::text
    AND ${rangeAt(range.index)} ->> 'expectation' = ${range.expectation}::text
    AND (${rangeAt(range.index)} ->> 'cursor')
      IS NOT DISTINCT FROM ${range.cursor}::text
    AND ${rangeAt(range.index)} -> 'completed' = 'false'::jsonb`;

/**
 * Start a census page of one range of an admitted route: the route's pass,
 * begun at the database clock if the route has none, bound to the engine
 * incarnation read just before and laid out in ranges by its first page. A
 * pass that already read another incarnation walked an index that is no
 * longer there: the proof is revoked and a new pass starts on this one, every
 * range over. A pass that started too long ago to prove the route is started
 * over (`pass_too_old_to_prove`). A range whose phase has not begun takes its
 * bound now. A replay converges on the row the first call wrote.
 */
export const startCorpusIndexRouteCensusPageTx = async (
  tx: Transaction,
  route: CorpusIndexRoute,
  observed: CorpusIndexIncarnation,
  request: CorpusIndexRouteCensusPageRequest = SINGLE_RANGE,
): Promise<CorpusIndexRouteCensusStart> => {
  if (
    !Number.isSafeInteger(request.ranges) ||
    request.ranges < 1 ||
    request.ranges > CORPUS_INDEX_ROUTE_PROOF_RANGES_MAX ||
    !Number.isSafeInteger(request.range) ||
    request.range < 0 ||
    request.range >= CORPUS_INDEX_ROUTE_PROOF_RANGES_MAX
  ) {
    return panic(
      `Route census page request out of bounds: range ${request.range} of ${request.ranges}`,
    );
  }
  const admission = await admitRouteTx(tx, route);
  if (admission.type === "refused") {
    return admission;
  }
  if (observed.type === "missing") {
    // A pass that read an index now gone proves nothing of it; a pass that
    // has not read one yet has nothing to void.
    await writeRouteProofTx(
      tx,
      sql`
      UPDATE ${proofs}
      SET revoked_at = clock_reading.at,
        revoke_reason = 'index_replaced',
        revoked_pass_number = ${proofs.passNumber} + 1,
        pass_number = ${proofs.passNumber} + 1,
        pass_id = gen_random_uuid(),
        pass_started_at = clock_reading.at,
        pass_through = ${presentThrough(route)},
        pass_expectation = 'present',
        pass_cursor = NULL,
        pass_inspected = 0,
        pass_index_incarnation = NULL,
        pass_ranges = NULL,
        updated_at = clock_reading.at
      FROM (SELECT clock_timestamp() AS at) AS clock_reading
      WHERE ${isRoute(route)} AND ${proofs.passIndexIncarnation} IS NOT NULL
    `,
    );
    return { type: "index_missing" };
  }
  const { pass: laidOut, restarted } = await openPassTx(
    tx,
    route,
    observed.incarnation,
    request.ranges,
  );
  return {
    ...(await openRangeTx(tx, route, laidOut, request.range)),
    restarted,
  };
};

/**
 * The route's pass, begun if the route has none, bound to `incarnation`
 * and laid out in ranges: a pass that read another incarnation is revoked
 * and begun again, one too old to prove is started over.
 */
const openPassTx = async (
  tx: Transaction,
  route: CorpusIndexRoute,
  observedIncarnation: string,
  requestedRanges: number,
): Promise<{
  pass: CorpusIndexRouteCensusPass;
  restarted: CorpusIndexRoutePassRestart | null;
}> => {
  await writeRouteProofTx(
    tx,
    sql`
    INSERT INTO ${proofs}
      (family, generation, index_id, pass_started_at, pass_expectation,
       pass_through, pass_index_incarnation)
    VALUES (
      ${route.family}, ${route.generation}, ${route.indexId},
      clock_timestamp(), 'present', ${presentThrough(route)},
      ${observedIncarnation}
    )
    ON CONFLICT ON CONSTRAINT corpus_index_route_proofs_pkey DO NOTHING
  `,
  );
  const { pass: found, tooOldToProve } = await readPassTx(tx, route);
  const replaced =
    found.incarnation !== null && found.incarnation !== observedIncarnation;
  if (replaced) {
    await revokeCorpusIndexRouteProofTx(tx, route, "index_replaced", {
      incarnation: observedIncarnation,
    });
  }
  // A revocation above already started a new pass. Otherwise a pass too old
  // to prove starts over; if another writer moved it first, its pass stands.
  const restarted =
    !replaced && tooOldToProve
      ? await restartPassTooOldToProveTx(tx, route, found, observedIncarnation)
      : null;
  const resumed =
    !replaced && tooOldToProve && restarted === null
      ? (await readPassTx(tx, route)).pass
      : found;
  // The pass's first engine read binds its incarnation.
  const unbound =
    replaced || restarted !== null || resumed.incarnation === null;
  if (unbound) {
    await writeRouteProofTx(
      tx,
      sql`
      UPDATE ${proofs}
      SET pass_index_incarnation = COALESCE(
          ${proofs.passIndexIncarnation}, ${observedIncarnation}
        ),
        updated_at = clock_timestamp()
      WHERE ${isRoute(route)}
    `,
    );
  }
  const bound = unbound ? (await readPassTx(tx, route)).pass : resumed;
  if (bound.ranges !== null) {
    return { pass: bound, restarted };
  }
  // The pass's first page lays its keys out in ranges.
  await layOutRangesTx(tx, route, bound, requestedRanges);
  return { pass: (await readPassTx(tx, route)).pass, restarted };
};

/**
 * One range of the pass, its phase's bound taken if the phase has not begun:
 * a range laid out on an empty route still walks what was applied before it
 * read anything. Idle when the pass has no such range, the range ended, or
 * the pass moved meanwhile.
 */
const openRangeTx = async (
  tx: Transaction,
  route: CorpusIndexRoute,
  laidOut: CorpusIndexRouteCensusPass,
  index: number,
): Promise<
  | {
      type: "pass";
      pass: CorpusIndexRouteCensusPass;
      range: CorpusIndexRouteCensusRange;
      routeHoldsNothing: boolean;
    }
  | { type: "range_idle"; pass: CorpusIndexRouteCensusPass }
> => {
  const asked = laidOut.ranges?.[index];
  if (asked === undefined || asked.completed) {
    return { type: "range_idle", pass: laidOut };
  }
  const incarnation =
    laidOut.incarnation ??
    panic("A bound route census pass has no incarnation");
  if (asked.cursor === null) {
    await writeRouteProofTx(
      tx,
      sql`
      UPDATE ${proofs}
      SET pass_ranges = ${withRange(
        asked.index,
        sql`jsonb_build_object('through', ${phaseThrough(
          route,
          asked.expectation,
          asked.bounds[asked.expectation],
        )}::text)`,
      )},
        updated_at = clock_timestamp()
      WHERE ${rangeIs(route, laidOut, asked, incarnation)}
    `,
    );
  }
  const pass =
    asked.cursor === null ? (await readPassTx(tx, route)).pass : laidOut;
  const range = pass.ranges?.[index];
  if (pass.id !== laidOut.id || range === undefined || range.completed) {
    return { type: "range_idle", pass };
  }
  const holdsNothing =
    range.expectation === "present" && range.through === null
      ? executedRows(
          await tx.execute(
            sql`SELECT ${presentThrough(route)} IS NULL AS holds_nothing`,
          ),
        ).at(0)
      : null;
  return {
    type: "pass",
    pass,
    range,
    routeHoldsNothing:
      isRecord(holdsNothing) && holdsNothing["holds_nothing"] === true,
  };
};

/** What one clean census page did to its range and the route's pass. */
export type CorpusIndexRouteCensusStep =
  | { type: "advanced" }
  | { type: "phase_completed" }
  /** The range ended both phases; another range of the pass has not. */
  | { type: "range_completed" }
  /** The range ended both phases, the last of its pass: the route is proven. */
  | { type: "proven" }
  /**
   * The pass or the range moved since it was read: another runner, a
   * revocation, or an engine incarnation other than the one the pass is
   * bound to.
   */
  | { type: "superseded" }
  /** The route stopped being one that may be walked; nothing recorded. */
  | { type: "refused"; refusal: CorpusIndexRouteRefusal };

/**
 * A pass proves a registered group's route only if it started no earlier
 * than the group's attestation. A new attestation revokes in its own
 * transaction, so this holds by construction; the check keeps it so if a
 * writer ever forgets.
 */
const startedAfterAttestation = (
  route: CorpusIndexRoute,
  gate: RouteGate,
): SQL =>
  gate.type === "manifest"
    ? sql`true`
    : sql`NOT EXISTS (
        SELECT 1
        FROM ${enrollments}, (SELECT ${passStart} AS started_at) AS proving
        WHERE ${enrollmentKey(route, [gate.indexGroup])}
          AND (attested_at IS NULL OR attested_at > proving.started_at)
      )`;

/**
 * Record one census page of one range that found no drift. A page short of
 * its phase's end moves the range's cursor; the end of `present` moves the
 * range on to `absent`; the end of `absent` ends the range. The range that
 * ends last makes the pass the route's proof, in the same row write as its
 * own end, and starts the next pass at the same instant, on the same
 * incarnation. `incarnation` is what the engine reported for this page; at
 * the end of a range's `absent` it must be read after the page's census, so
 * the range's last observation and the pass's incarnation agree.
 */
export const recordCorpusIndexRouteCensusPageTx = async (
  tx: Transaction,
  {
    route,
    pass,
    range,
    incarnation,
    inspected,
    nextCursor,
    complete,
  }: {
    route: CorpusIndexRoute;
    pass: CorpusIndexRouteCensusPass;
    range: CorpusIndexRouteCensusRange;
    incarnation: string;
    inspected: number;
    nextCursor: string | null;
    complete: boolean;
  },
): Promise<CorpusIndexRouteCensusStep> => {
  if (!Number.isSafeInteger(inspected) || inspected < 0) {
    return panic(`Invalid route census page count: ${inspected}`);
  }
  const admission = await admitRouteTx(tx, route);
  if (admission.type === "refused") {
    return admission;
  }
  const step = ((): "advanced" | "phase_completed" | "range_completed" => {
    if (!complete) {
      return "advanced";
    }
    return range.expectation === "present"
      ? "phase_completed"
      : "range_completed";
  })();
  const walked = sql`(${rangeAt(range.index)} ->> 'inspected')::bigint + ${inspected}::bigint`;
  const fields = (() => {
    switch (step) {
      case "advanced":
        return sql`jsonb_build_object(
          'cursor', ${nextCursor}::uuid::text, 'inspected', ${walked})`;
      case "phase_completed":
        return sql`jsonb_build_object(
          'expectation', 'absent'::text,
          'cursor', NULL::text,
          'through', ${absentThrough(route, range.bounds.absent)}::text,
          'inspected', ${walked})`;
      case "range_completed":
        return sql`jsonb_build_object('completed', true, 'inspected', ${walked})`;
      default:
        step satisfies never;
        return panic("Unhandled route census step");
    }
  })();
  // Concurrent pages of other ranges update the same row: each re-reads the
  // row a concurrent one committed before applying its own range, so the
  // last range to end sees every other one ended.
  const updated = await writeRouteProofTx(
    tx,
    sql`
      UPDATE ${proofs}
      SET pass_ranges = ${withRange(range.index, fields)},
        updated_at = clock_timestamp()
      WHERE ${rangeIs(route, pass, range, incarnation)}
      RETURNING NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(${proofs.passRanges} -> 'ranges') AS laid(value)
        WHERE laid.value -> 'completed' <> 'true'::jsonb
      ) AS all_completed
    `,
  );
  const row = updated.at(0);
  if (row === undefined) {
    return { type: "superseded" };
  }
  if (
    step !== "range_completed" ||
    !isRecord(row) ||
    row["all_completed"] !== true
  ) {
    return { type: step };
  }
  // Every range of the pass ended both phases on its incarnation: the pass's
  // own number, start (its earliest range's) and incarnation become the
  // proof; the next pass keeps the incarnation it was read on.
  const proven = await writeRouteProofTx(
    tx,
    sql`
      UPDATE ${proofs}
      SET proven_pass_number = pass_number,
        proven_pass_started_at = ${passStart},
        proven_at = clock_reading.at,
        proven_inspected = ${passInspected},
        proven_index_incarnation = pass_index_incarnation,
        pass_number = ${proofs.passNumber} + 1,
        pass_id = gen_random_uuid(),
        pass_started_at = clock_reading.at,
        pass_through = ${presentThrough(route)},
        pass_expectation = 'present',
        pass_cursor = NULL,
        pass_inspected = 0,
        pass_ranges = NULL,
        updated_at = clock_reading.at
      FROM (SELECT clock_timestamp() AS at) AS clock_reading
      WHERE ${isRoute(route)}
        AND ${proofs.passId} = ${pass.id}::uuid
        AND ${startedAfterAttestation(route, admission.gate)}
      RETURNING ${proofs.indexId}
    `,
  );
  if (proven.length === 1) {
    return { type: "proven" };
  }
  // A pass older than its group's attestation proves nothing; never so while
  // every new attestation revokes, so a writer that forgot is caught here.
  await revokeCorpusIndexRouteProofTx(tx, route, "group_attested", {
    incarnation,
  });
  return { type: "superseded" };
};

/**
 * Whether a declared route's proof counts, decided on the database clock:
 *
 * - `current`: a pass completed clean, started no earlier than the route's
 *   last revocation and its group's attestation, and started within the
 *   maximum age;
 * - `never_proven`: no row, or no pass has completed clean;
 * - `revoked`: a change voiding the proof landed after the proving pass began;
 * - `expired`: the proving pass started longer ago than the maximum age;
 * - `unattested`: the route's group is not attested now, so whatever its row
 *   says, it cannot be served.
 */
type CorpusIndexRouteProofStatus =
  | {
      type: "current";
      provenAtUs: string;
      provenPassStartedAtUs: string;
      inspected: number;
      incarnation: string;
    }
  | { type: "never_proven" }
  | { type: "revoked"; reason: CorpusIndexRouteProofRevokeReason }
  | { type: "expired"; provenPassStartedAtUs: string }
  | Extract<CorpusIndexRouteRefusal, { type: "unattested" }>;

type CorpusIndexRouteProofReading = {
  indexId: string;
  status: CorpusIndexRouteProofStatus;
  /** The pass under way; null when no pass ever reached the route. */
  pass: CorpusIndexRouteCensusPass | null;
};

/** A declared route whose proof counts, with what the flip re-checks. */
type CurrentCorpusIndexRouteProof = {
  indexId: string;
  /** The engine incarnation the proving pass walked. */
  incarnation: string;
  provenPassStartedAtUs: string;
  provenAtUs: string;
  inspected: number;
};

/**
 * The proofs of every route the generation's manifest declares. Only
 * `all_current` names no route that is not ready, and it is returned only
 * when every declared route (at least one) is current: a route without a row
 * reads `never_proven`, never as absent from the list. `undeclared` lists
 * rows of routes the manifest no longer declares; they prove nothing.
 */
export type CorpusIndexGenerationRouteProofs =
  | {
      type: "all_current";
      routes: CurrentCorpusIndexRouteProof[];
      undeclared: string[];
    }
  | {
      type: "not_ready";
      routes: CorpusIndexRouteProofReading[];
      undeclared: string[];
    }
  | Extract<
      CorpusIndexRouteRefusal,
      { type: "generation_absent" | "open_route_set" }
    >;

/** Generous bound on the routes one generation has; a handful in practice. */
const ROUTE_PROOFS_READ_MAX = 256;

/**
 * Read the generation's route proofs, each judged on the database clock.
 * `maxAgeHours` may only tighten the proof's maximum age.
 */
export const readCorpusIndexRouteProofsTx = async (
  tx: Transaction,
  target: Pick<CorpusIndexRoute, "family" | "generation">,
  {
    maxAgeHours = CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS,
  }: { maxAgeHours?: number } = {},
): Promise<CorpusIndexGenerationRouteProofs> => {
  if (
    !Number.isFinite(maxAgeHours) ||
    maxAgeHours <= 0 ||
    maxAgeHours > CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS
  ) {
    return panic(`Route proof age outside its bound: ${maxAgeHours}`);
  }
  const manifest = await readRegisteredManifestTx(tx, target);
  if (manifest === null) {
    return { type: "generation_absent" };
  }
  const routes = declaredRoutes(manifest);
  if (routes === null) {
    return { type: "open_route_set" };
  }
  const enrolled = await readEnrollmentsTx(
    tx,
    target,
    routes.flatMap(({ gate }) =>
      gate.type === "enrollment" ? [gate.indexGroup] : [],
    ),
  );
  const rows = executedRows(
    await tx.execute(sql`
      SELECT ${proofs.indexId} AS index_id,
        ${proofs.provenAt} IS NOT NULL AS proven,
        ${proofs.revokedAt} IS NOT NULL
          AND ${proofs.provenPassNumber} < ${proofs.revokedPassNumber}
          AS revoked,
        ${startedWithinMaxAge(sql`${proofs.provenPassStartedAt}`, maxAgeHours)}
          AS fresh,
        -- A proving pass older than its group's attestation walked an index
        -- the attestation does not vouch for (never so while every new
        -- attestation revokes; kept so if a writer ever forgets).
        EXISTS (
          SELECT 1 FROM ${enrollments}
          WHERE ${enrollments.family} = ${target.family}
            AND ${enrollments.generation} = ${target.generation}
            AND physical_index_id = corpus_index_route_proofs.index_id
            AND attested_at > corpus_index_route_proofs.proven_pass_started_at
        ) AS predates_attestation,
        ${proofs.revokeReason} AS revoke_reason,
        ${epochMicros(sql`${proofs.provenAt}`)}::text AS proven_at_us,
        ${epochMicros(sql`${proofs.provenPassStartedAt}`)}::text AS proven_pass_started_at_us,
        ${proofs.provenInspected}::int AS proven_inspected,
        ${proofs.provenIndexIncarnation} AS proven_incarnation,
        ${passColumns}
      FROM ${proofs}
      WHERE ${proofs.family} = ${target.family}
        AND ${proofs.generation} = ${target.generation}
      ORDER BY ${proofs.indexId}
      LIMIT ${ROUTE_PROOFS_READ_MAX + 1}
    `),
  );
  if (rows.length > ROUTE_PROOFS_READ_MAX) {
    return panic(
      `A generation holds more route proofs than routes: ${target.generation}`,
    );
  }
  const rowOf = new Map(
    rows.map((row) => [requiredText(row, "index_id"), row]),
  );
  const readings = routes.map(
    ({ indexId, gate }): CorpusIndexRouteProofReading => {
      const row = rowOf.get(indexId);
      const pass = row === undefined ? null : passOf(row);
      const judge = (): CorpusIndexRouteProofStatus => {
        const attestation =
          gate.type === "manifest"
            ? null
            : enrollmentGate(gate, enrolled.get(gate.indexGroup));
        if (attestation?.type === "unattested") {
          return attestation;
        }
        if (row === undefined || !isRecord(row) || row["proven"] !== true) {
          return { type: "never_proven" };
        }
        if (row["revoked"] === true) {
          return {
            type: "revoked",
            reason: revokeReason(requiredText(row, "revoke_reason")),
          };
        }
        const provenPassStartedAtUs = requiredText(
          row,
          "proven_pass_started_at_us",
        );
        if (row["predates_attestation"] === true) {
          return { type: "revoked", reason: "group_attested" };
        }
        if (row["fresh"] !== true) {
          return { type: "expired", provenPassStartedAtUs };
        }
        return {
          type: "current",
          provenAtUs: requiredText(row, "proven_at_us"),
          provenPassStartedAtUs,
          inspected: requiredCount(row, "proven_inspected"),
          incarnation: requiredText(row, "proven_incarnation"),
        };
      };
      return { indexId, status: judge(), pass };
    },
  );
  const declared = new Set(routes.map(({ indexId }) => indexId));
  const undeclared = [...rowOf.keys()].filter(
    (indexId) => !declared.has(indexId),
  );
  const current = readings.flatMap(({ indexId, status }) =>
    status.type === "current"
      ? [
          {
            indexId,
            incarnation: status.incarnation,
            provenPassStartedAtUs: status.provenPassStartedAtUs,
            provenAtUs: status.provenAtUs,
            inspected: status.inspected,
          },
        ]
      : [],
  );
  return current.length > 0 && current.length === readings.length
    ? { type: "all_current", routes: current, undeclared }
    : { type: "not_ready", routes: readings, undeclared };
};

/**
 * The flip's last look at the engine: does every index still hold the
 * incarnation its proof walked? Called under the flip's fence, after
 * `readCorpusIndexRouteProofsTx` answered `all_current`; an index deleted,
 * recreated or restored since the walk reads `replaced`.
 */
export const checkCorpusIndexRouteProofIncarnations = async ({
  client,
  proofs: { routes },
}: {
  client: Pick<CorpusIndexClient, "readIndexIncarnation">;
  proofs: Extract<CorpusIndexGenerationRouteProofs, { type: "all_current" }>;
}): Promise<
  Result<
    { type: "held" } | { type: "replaced"; indexIds: string[] },
    CorpusIndexError
  >
> => {
  const replaced: string[] = [];
  for (const { indexId, incarnation } of routes) {
    const observed = await client.readIndexIncarnation(indexId, "unobserved");
    if (observed.isErr()) {
      return Result.err(observed.error);
    }
    if (
      observed.value.type === "missing" ||
      observed.value.incarnation !== incarnation
    ) {
      replaced.push(indexId);
    }
  }
  return Result.ok(
    replaced.length === 0
      ? { type: "held" }
      : { type: "replaced", indexIds: replaced },
  );
};
