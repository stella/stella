/**
 * The durable readiness proof of one route (physical index) of a corpus
 * generation: one row per route in `corpus_index_route_proofs`.
 *
 * Cost under continuous inflow. Ordinary projection writes never touch the
 * table: no trigger, no counter, nothing to keep current per decision. A
 * census page costs one primary-key read here and one primary-key update,
 * beside the census page itself. A drift repair costs one primary-key update
 * in its own transaction. So keeping a route proven costs one census pass per
 * proof lifetime, whatever the generation's write rate.
 *
 * Every write is a compare-and-set on the row's own pass identity (number,
 * phase, cursor), so two runners walking one route never both advance it, and
 * a revocation that lands while a page is read wins over that page.
 */
import { panic } from "better-result";
import { type SQL, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  corpusIndexRouteProofs,
} from "@/api/db/schema";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  CORPUS_INDEX_ROUTE_CENSUS_EXPECTATIONS,
  CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS,
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
 */
export type CorpusIndexRouteCensusPass = {
  number: number;
  id: string;
  through: string | null;
  startedAtUs: string;
  expectation: CorpusIndexRouteCensusExpectation;
  cursor: string | null;
  inspected: number;
};

const proofs = corpusIndexRouteProofs;

const epochMicros = (instant: SQL): SQL =>
  sql`(extract(epoch FROM ${instant}) * 1000000)::bigint`;

const isRoute = ({ family, generation, indexId }: CorpusIndexRoute): SQL =>
  sql`${proofs.family} = ${family}
    AND ${proofs.generation} = ${generation}
    AND ${proofs.indexId} = ${indexId}`;

const states = corpusIndexProjectionStates;
const intents = corpusIndexProjectionIntents;

/**
 * The last applied revision's entity the `present` phase walks: the largest
 * key of the applied-census index when the phase begins. A revision applied
 * later with a larger key was proven present by its own apply.
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
 * phase begins. One settled or withdrawn later with a larger id was proven
 * gone when it got that status.
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

/**
 * The one writer of route proofs. A proof is bookkeeping derived from the
 * public corpus projection and the engine, rewritten on every census page, so
 * no write of it is an audited action; the drift repairs that revoke it record
 * their own outcome.
 */
const writeRouteProofTx = async (
  tx: Transaction,
  statement: SQL,
): Promise<unknown[]> =>
  // audit: skip - derived public corpus projection bookkeeping
  executedRows(await tx.execute(statement));

/**
 * The route's pass, starting one at the database clock if the route has no
 * proof row yet. A replay converges on the row the first call wrote.
 */
export const ensureCorpusIndexRouteCensusPassTx = async (
  tx: Transaction,
  route: CorpusIndexRoute,
): Promise<CorpusIndexRouteCensusPass> => {
  await writeRouteProofTx(
    tx,
    sql`
    INSERT INTO ${proofs}
      (family, generation, index_id, pass_started_at, pass_expectation,
       pass_through)
    VALUES (
      ${route.family}, ${route.generation}, ${route.indexId},
      clock_timestamp(), 'present', ${presentThrough(route)}
    )
    ON CONFLICT ON CONSTRAINT corpus_index_route_proofs_pkey DO NOTHING
  `,
  );
  const row = executedRows(
    await tx.execute(sql`
      SELECT ${proofs.passNumber}::int AS pass_number,
        ${proofs.passId}::text AS pass_id,
        ${proofs.passThrough}::text AS pass_through,
        ${epochMicros(sql`${proofs.passStartedAt}`)}::text AS started_at_us,
        ${proofs.passExpectation} AS expectation,
        ${proofs.passCursor}::text AS cursor,
        ${proofs.passInspected}::int AS inspected
      FROM ${proofs}
      WHERE ${isRoute(route)}
    `),
  ).at(0);
  return {
    number: requiredCount(row, "pass_number"),
    id: requiredText(row, "pass_id"),
    through: nullableText(row, "pass_through"),
    startedAtUs: requiredText(row, "started_at_us"),
    expectation: censusExpectation(requiredText(row, "expectation")),
    cursor: nullableText(row, "cursor"),
    inspected: requiredCount(row, "inspected"),
  };
};

/** What one clean census page did to the route's pass. */
export type CorpusIndexRouteCensusStep =
  | { type: "advanced" }
  | { type: "phase_completed" }
  | { type: "proven" }
  /** The pass moved since it was read: another runner, or a revocation. */
  | { type: "superseded" };

const passIs = (
  route: CorpusIndexRoute,
  pass: CorpusIndexRouteCensusPass,
): SQL =>
  sql`${isRoute(route)}
    AND ${proofs.passNumber} = ${pass.number}
    AND ${proofs.passId} = ${pass.id}::uuid
    AND ${proofs.passExpectation} = ${pass.expectation}
    AND ${proofs.passCursor} IS NOT DISTINCT FROM ${pass.cursor}::uuid`;

/**
 * Record one census page that found no drift. A page short of its phase's end
 * moves the cursor; the end of `present` moves on to `absent`; the end of
 * `absent` makes the pass the route's proof and starts the next pass at the
 * same instant.
 */
export const recordCorpusIndexRouteCensusPageTx = async (
  tx: Transaction,
  {
    route,
    pass,
    inspected,
    nextCursor,
    complete,
  }: {
    route: CorpusIndexRoute;
    pass: CorpusIndexRouteCensusPass;
    inspected: number;
    nextCursor: string | null;
    complete: boolean;
  },
): Promise<CorpusIndexRouteCensusStep> => {
  if (!Number.isSafeInteger(inspected) || inspected < 0) {
    return panic(`Invalid route census page count: ${inspected}`);
  }
  const step = ((): Exclude<
    CorpusIndexRouteCensusStep,
    { type: "superseded" }
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
        // The finished pass's own number and start, as the row holds them.
        return sql`proven_pass_number = pass_number,
          proven_pass_started_at = pass_started_at,
          proven_at = clock_reading.at,
          proven_inspected = ${proofs.passInspected} + ${inspected},
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
      WHERE ${passIs(route, pass)}
      RETURNING ${proofs.indexId}
    `,
  );
  return updated.length === 1 ? step : { type: "superseded" };
};

/**
 * A repair of drift on the route revokes its proof and restarts its pass at
 * the same instant, so only a pass started after the repair can prove the
 * route again. Called in the repair's own transaction, after the repair's row
 * locks: the proof row is always the last lock a projection transaction takes.
 * A route never walked has no proof to revoke.
 */
export const revokeCorpusIndexRouteProofTx = async (
  tx: Transaction,
  route: CorpusIndexRoute,
  reason: CorpusIndexRouteProofRevokeReason,
): Promise<void> => {
  await writeRouteProofTx(
    tx,
    sql`
    UPDATE ${proofs}
    SET revoked_at = clock_reading.at,
      revoke_reason = ${reason},
      revoked_pass_number = ${proofs.passNumber} + 1,
      pass_number = ${proofs.passNumber} + 1,
      pass_id = gen_random_uuid(),
      pass_started_at = clock_reading.at,
      pass_through = ${presentThrough(route)},
      pass_expectation = 'present',
      pass_cursor = NULL,
      pass_inspected = 0,
      updated_at = clock_reading.at
    FROM (SELECT clock_timestamp() AS at) AS clock_reading
    WHERE ${isRoute(route)}
  `,
  );
};

/**
 * Whether a route's proof counts, decided on the database clock:
 *
 * - `current`: a pass completed clean, started no earlier than the route's
 *   last revocation, and completed within the proof's maximum age;
 * - `never_proven`: no pass has completed clean;
 * - `revoked`: drift was repaired on the route after the proving pass started;
 * - `expired`: the proving pass is older than the maximum age.
 */
type CorpusIndexRouteProofStatus =
  | {
      type: "current";
      provenAtUs: string;
      provenPassStartedAtUs: string;
      inspected: number;
    }
  | { type: "never_proven" }
  | { type: "revoked"; reason: CorpusIndexRouteProofRevokeReason }
  | { type: "expired"; provenAtUs: string };

export type CorpusIndexRouteProofReading = {
  indexId: string;
  status: CorpusIndexRouteProofStatus;
  pass: CorpusIndexRouteCensusPass;
};

/** Generous bound on the routes one generation has; a handful in practice. */
const ROUTE_PROOFS_READ_MAX = 256;

const revokeReason = (value: string): CorpusIndexRouteProofRevokeReason =>
  value === "present_drift" || value === "absent_drift"
    ? value
    : panic(`Unknown route proof revoke reason: ${value}`);

/** Every route proof of a generation, each judged on the database clock. */
export const readCorpusIndexRouteProofsTx = async (
  tx: Transaction,
  { family, generation }: Pick<CorpusIndexRoute, "family" | "generation">,
): Promise<CorpusIndexRouteProofReading[]> => {
  const rows = executedRows(
    await tx.execute(sql`
      SELECT ${proofs.indexId} AS index_id,
        CASE
          WHEN ${proofs.provenAt} IS NULL THEN 'never_proven'
          WHEN ${proofs.revokedAt} IS NOT NULL
            AND ${proofs.provenPassNumber} < ${proofs.revokedPassNumber}
            THEN 'revoked'
          WHEN ${proofs.provenAt} < clock_timestamp()
            - make_interval(hours => ${CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS})
            THEN 'expired'
          ELSE 'current'
        END AS status,
        ${proofs.revokeReason} AS revoke_reason,
        ${epochMicros(sql`${proofs.provenAt}`)}::text AS proven_at_us,
        ${epochMicros(sql`${proofs.provenPassStartedAt}`)}::text AS proven_pass_started_at_us,
        ${proofs.provenInspected}::int AS proven_inspected,
        ${proofs.passNumber}::int AS pass_number,
        ${proofs.passId}::text AS pass_id,
        ${proofs.passThrough}::text AS pass_through,
        ${epochMicros(sql`${proofs.passStartedAt}`)}::text AS started_at_us,
        ${proofs.passExpectation} AS expectation,
        ${proofs.passCursor}::text AS cursor,
        ${proofs.passInspected}::int AS inspected
      FROM ${proofs}
      WHERE ${proofs.family} = ${family}
        AND ${proofs.generation} = ${generation}
      ORDER BY ${proofs.indexId}
      LIMIT ${ROUTE_PROOFS_READ_MAX + 1}
    `),
  );
  if (rows.length > ROUTE_PROOFS_READ_MAX) {
    return panic(
      `A generation holds more route proofs than routes: ${generation}`,
    );
  }
  return rows.map((row) => {
    const pass = {
      number: requiredCount(row, "pass_number"),
      id: requiredText(row, "pass_id"),
      through: nullableText(row, "pass_through"),
      startedAtUs: requiredText(row, "started_at_us"),
      expectation: censusExpectation(requiredText(row, "expectation")),
      cursor: nullableText(row, "cursor"),
      inspected: requiredCount(row, "inspected"),
    };
    const status = requiredText(row, "status");
    const judged = ((): CorpusIndexRouteProofStatus => {
      switch (status) {
        case "never_proven":
          return { type: "never_proven" };
        case "revoked":
          return {
            type: "revoked",
            reason: revokeReason(requiredText(row, "revoke_reason")),
          };
        case "expired":
          return {
            type: "expired",
            provenAtUs: requiredText(row, "proven_at_us"),
          };
        case "current":
          return {
            type: "current",
            provenAtUs: requiredText(row, "proven_at_us"),
            provenPassStartedAtUs: requiredText(
              row,
              "proven_pass_started_at_us",
            ),
            inspected: requiredCount(row, "proven_inspected"),
          };
        default:
          return panic(`Unknown route proof status: ${status}`);
      }
    })();
    return {
      indexId: requiredText(row, "index_id"),
      status: judged,
      pass,
    };
  });
};
