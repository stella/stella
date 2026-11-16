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
 * Every write is a compare-and-set on the row's own pass identity (number,
 * id, phase, cursor, incarnation), so two runners walking one route never
 * both advance it, and a revocation that lands while a page is read wins.
 */
import { panic, Result } from "better-result";
import { and, eq, type SQL, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexGroupEnrollments,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  corpusIndexRouteProofs,
} from "@/api/db/schema";
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
  CORPUS_INDEX_ROUTE_PROOF_REVOKE_REASONS,
  type CorpusIndexRouteCensusExpectation,
  type CorpusIndexRouteProofRevokeReason,
} from "@/api/lib/legal-search/corpus-index-route-proof-contract";
import { isRecord } from "@/api/lib/type-guards";

export type CorpusIndexRoute = {
  family: CorpusFamily;
  generation: string;
  indexId: string;
};

/**
 * Where a route's census pass stands. `number` orders passes and `id`
 * identifies one, so a page read for a pass never matches another; the start
 * is in epoch microseconds, PostgreSQL's precision. `through` is the last key
 * the current phase walks, null when the phase has nothing to walk.
 * `incarnation` is the engine index the pass read first, null before that.
 */
export type CorpusIndexRouteCensusPass = {
  number: number;
  id: string;
  through: string | null;
  startedAtUs: string;
  expectation: CorpusIndexRouteCensusExpectation;
  cursor: string | null;
  inspected: number;
  incarnation: string | null;
};

const proofs = corpusIndexRouteProofs;
const states = corpusIndexProjectionStates;
const intents = corpusIndexProjectionIntents;
const enrollments = corpusIndexGroupEnrollments;

const epochMicros = (instant: SQL): SQL =>
  sql`(extract(epoch FROM ${instant}) * 1000000)::bigint`;

const isRoute = ({ family, generation, indexId }: CorpusIndexRoute): SQL =>
  sql`${proofs.family} = ${family}
    AND ${proofs.generation} = ${generation}
    AND ${proofs.indexId} = ${indexId}`;

/**
 * The last applied revision's entity the `present` phase walks: the largest
 * key of the applied-census index when the phase begins. The bound only lets
 * the phase end under inflow; what is applied later, at any key, carried its
 * own presence proof.
 */
const presentThrough = ({ family, generation, indexId }: CorpusIndexRoute) =>
  sql`(
    SELECT ${states.entityId}
    FROM ${states}
    WHERE ${states.family} = ${family}
      AND ${states.generation} = ${generation}
      AND ${states.appliedIndexId} = ${indexId}
      AND ${states.appliedAction} = 'upsert'
      AND ${states.appliedRevision} IS NOT NULL
    ORDER BY ${states.entityId} DESC
    LIMIT 1
  )`;

/**
 * The last deleted revision the `absent` phase walks: the larger of the
 * largest settled and the largest withdrawn revision id of the index when the
 * phase begins. As for `presentThrough`, a revision settled or withdrawn
 * later carried its own observation of absence.
 */
const absentThrough = ({ family, generation, indexId }: CorpusIndexRoute) => {
  const largest = (status: "settled" | "withdrawn") => sql`(
      SELECT ${intents.id} AS id
      FROM ${intents}
      WHERE ${intents.family} = ${family}
        AND ${intents.generation} = ${generation}
        AND ${intents.indexId} = ${indexId}
        AND ${intents.status} = ${sql.raw(`'${status}'`)}
      ORDER BY ${intents.id} DESC
      LIMIT 1
    )`;
  return sql`(
    SELECT deleted.id
    FROM (${largest("settled")} UNION ALL ${largest("withdrawn")}) AS deleted
    ORDER BY deleted.id DESC
    LIMIT 1
  )`;
};

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
  ${proofs.passThrough}::text AS pass_through,
  ${epochMicros(sql`${proofs.passStartedAt}`)}::text AS started_at_us,
  ${proofs.passExpectation} AS expectation,
  ${proofs.passCursor}::text AS cursor,
  ${proofs.passInspected}::int AS inspected,
  ${proofs.passIndexIncarnation} AS incarnation`;

const passOf = (row: unknown): CorpusIndexRouteCensusPass => ({
  number: requiredCount(row, "pass_number"),
  id: requiredText(row, "pass_id"),
  through: nullableText(row, "pass_through"),
  startedAtUs: requiredText(row, "started_at_us"),
  expectation: censusExpectation(requiredText(row, "expectation")),
  cursor: nullableText(row, "cursor"),
  inspected: requiredCount(row, "inspected"),
  incarnation: nullableText(row, "incarnation"),
});

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

/** What starting a census page found. */
export type CorpusIndexRouteCensusStart =
  | { type: "pass"; pass: CorpusIndexRouteCensusPass }
  | { type: "refused"; refusal: CorpusIndexRouteRefusal }
  /** The engine holds no index under the route's id. */
  | { type: "index_missing" };

/**
 * Start a census page of an admitted route: the route's pass, begun at the
 * database clock if the route has none, bound to the engine incarnation read
 * just before. A pass that already read another incarnation walked an index
 * that is no longer there: the proof is revoked and a new pass starts on this
 * one. A replay converges on the row the first call wrote.
 */
export const startCorpusIndexRouteCensusPageTx = async (
  tx: Transaction,
  route: CorpusIndexRoute,
  observed: CorpusIndexIncarnation,
): Promise<CorpusIndexRouteCensusStart> => {
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
        updated_at = clock_reading.at
      FROM (SELECT clock_timestamp() AS at) AS clock_reading
      WHERE ${isRoute(route)} AND ${proofs.passIndexIncarnation} IS NOT NULL
    `,
    );
    return { type: "index_missing" };
  }
  await writeRouteProofTx(
    tx,
    sql`
    INSERT INTO ${proofs}
      (family, generation, index_id, pass_started_at, pass_expectation,
       pass_through, pass_index_incarnation)
    VALUES (
      ${route.family}, ${route.generation}, ${route.indexId},
      clock_timestamp(), 'present', ${presentThrough(route)},
      ${observed.incarnation}
    )
    ON CONFLICT ON CONSTRAINT corpus_index_route_proofs_pkey DO NOTHING
  `,
  );
  const read = async () =>
    passOf(
      executedRows(
        await tx.execute(sql`
          SELECT ${passColumns} FROM ${proofs} WHERE ${isRoute(route)}
        `),
      ).at(0) ?? panic(`Route proof row was lost: ${route.indexId}`),
    );
  const found = await read();
  const replaced =
    found.incarnation !== null && found.incarnation !== observed.incarnation;
  if (replaced) {
    await revokeCorpusIndexRouteProofTx(tx, route, "index_replaced", {
      incarnation: observed.incarnation,
    });
  }
  // A phase not yet begun takes its bound now, when its first page is read:
  // a pass created on an empty route still walks what was applied before it
  // read anything. The pass's first engine read binds its incarnation.
  const pass =
    replaced || found.cursor === null || found.incarnation === null
      ? passOf(
          (
            await writeRouteProofTx(
              tx,
              sql`
            UPDATE ${proofs}
            SET pass_index_incarnation = COALESCE(
                ${proofs.passIndexIncarnation}, ${observed.incarnation}
              ),
              pass_through = CASE WHEN ${proofs.passCursor} IS NULL
                THEN CASE ${proofs.passExpectation}
                  WHEN 'present' THEN ${presentThrough(route)}
                  ELSE ${absentThrough(route)}
                END
                ELSE ${proofs.passThrough}
              END,
              updated_at = clock_timestamp()
            WHERE ${isRoute(route)}
            RETURNING ${passColumns}
          `,
            )
          ).at(0) ?? panic(`Route proof row was lost: ${route.indexId}`),
        )
      : found;
  return { type: "pass", pass };
};

/** What one clean census page did to the route's pass. */
export type CorpusIndexRouteCensusStep =
  | { type: "advanced" }
  | { type: "phase_completed" }
  | { type: "proven" }
  /**
   * The pass moved since it was read: another runner, a revocation, or an
   * engine incarnation other than the one the pass is bound to.
   */
  | { type: "superseded" }
  /** The route stopped being one that may be walked; nothing recorded. */
  | { type: "refused"; refusal: CorpusIndexRouteRefusal };

const passIs = (
  route: CorpusIndexRoute,
  pass: CorpusIndexRouteCensusPass,
  incarnation: string,
): SQL =>
  sql`${isRoute(route)}
    AND ${proofs.passNumber} = ${pass.number}
    AND ${proofs.passId} = ${pass.id}::uuid
    AND ${proofs.passExpectation} = ${pass.expectation}
    AND ${proofs.passCursor} IS NOT DISTINCT FROM ${pass.cursor}::uuid
    AND ${proofs.passIndexIncarnation} = ${incarnation}`;

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
        SELECT 1 FROM ${enrollments}
        WHERE ${enrollmentKey(route, [gate.indexGroup])}
          AND (attested_at IS NULL
            OR attested_at > corpus_index_route_proofs.pass_started_at)
      )`;

/**
 * Record one census page that found no drift. A page short of its phase's end
 * moves the cursor; the end of `present` moves on to `absent`; the end of
 * `absent` makes the pass the route's proof and starts the next pass at the
 * same instant, on the same incarnation. `incarnation` is what the engine
 * reported for this page; at the end of `absent` it must be read after the
 * page's census, so the proof's last observation and its incarnation agree.
 */
export const recordCorpusIndexRouteCensusPageTx = async (
  tx: Transaction,
  {
    route,
    pass,
    incarnation,
    inspected,
    nextCursor,
    complete,
  }: {
    route: CorpusIndexRoute;
    pass: CorpusIndexRouteCensusPass;
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
  const step = ((): Exclude<
    CorpusIndexRouteCensusStep,
    { type: "superseded" | "refused" }
  > => {
    if (!complete) {
      return { type: "advanced" };
    }
    return pass.expectation === "present"
      ? { type: "phase_completed" }
      : { type: "proven" };
  })();
  const set = (() => {
    switch (step.type) {
      case "advanced":
        return sql`pass_cursor = ${nextCursor}::uuid,
          pass_inspected = ${proofs.passInspected} + ${inspected}`;
      case "phase_completed":
        return sql`pass_expectation = 'absent',
          pass_cursor = NULL,
          pass_through = ${absentThrough(route)},
          pass_inspected = ${proofs.passInspected} + ${inspected}`;
      case "proven":
        // The finished pass's own number, start and incarnation, as the row
        // holds them; the next pass keeps the incarnation it was read on.
        return sql`proven_pass_number = pass_number,
          proven_pass_started_at = pass_started_at,
          proven_at = clock_reading.at,
          proven_inspected = ${proofs.passInspected} + ${inspected},
          proven_index_incarnation = pass_index_incarnation,
          pass_number = ${proofs.passNumber} + 1,
          pass_id = gen_random_uuid(),
          pass_started_at = clock_reading.at,
          pass_through = ${presentThrough(route)},
          pass_expectation = 'present',
          pass_cursor = NULL,
          pass_inspected = 0`;
      default:
        step satisfies never;
        return panic("Unhandled route census step");
    }
  })();
  const updated = await writeRouteProofTx(
    tx,
    sql`
      UPDATE ${proofs}
      SET ${set},
        updated_at = clock_reading.at
      FROM (SELECT clock_timestamp() AS at) AS clock_reading
      WHERE ${passIs(route, pass, incarnation)}
        AND ${step.type === "proven" ? startedAfterAttestation(route, admission.gate) : sql`true`}
      RETURNING ${proofs.indexId}
    `,
  );
  return updated.length === 1 ? step : { type: "superseded" };
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

export type CorpusIndexRouteProofReading = {
  indexId: string;
  status: CorpusIndexRouteProofStatus;
  /** The pass under way; null when no pass ever reached the route. */
  pass: CorpusIndexRouteCensusPass | null;
};

/** A declared route whose proof counts, with what the flip re-checks. */
export type CurrentCorpusIndexRouteProof = {
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
        ${proofs.provenPassStartedAt} >= clock_timestamp()
          - make_interval(secs => ${Math.round(maxAgeHours * 3600)})
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
        if (attestation !== null && attestation.type === "unattested") {
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
    // db-await-in-loop: one metadata read per route, a handful per flip
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
