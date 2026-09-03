/**
 * The only two doors through which an operator script reaches the case-law
 * tables.
 *
 * Two passes that each behave on their own can still deadlock together: a
 * row-by-row backfill holds row locks on `case_law_decisions` while a citation
 * pass takes `FOR KEY SHARE` on the same rows for its foreign keys. Neither
 * script can know the other is running, so the guarantee lives in the
 * database: every writing pass takes one session-level advisory lock before
 * its first statement, and a second pass waits at the door instead of
 * interleaving.
 *
 * A script does not import a database handle; it asks one of these two
 * functions for one, so there is no third way to reach the tables:
 *
 * - `enterCaseLawMaintenanceLane()` holds the lane and hands out the
 *   write-capable handles.
 * - `openCaseLawReadOnlySession()` hands out handles whose every transaction
 *   is `READ ONLY`. A helper that writes through one fails with SQLSTATE
 *   25006 at the first statement, so a script that claims to only read
 *   cannot quietly become a writer that skipped the lane.
 *
 * Both return the same shape, so a script with a plan mode and an apply mode
 * picks its door after parsing arguments and runs one body against either.
 *
 * This is a different lock from `lockCitationGraph` in the resolver. That one
 * is transaction-scoped and serializes the standing walk's batches against
 * ingestion; this one is session-scoped and serializes whole operator runs
 * against each other. A pass that also writes the graph still takes the graph
 * lock inside its transactions.
 *
 * The lane holds its own single connection for the life of the process, so
 * the lock cannot be lost to pool recycling. Postgres releases a session
 * advisory lock when that session ends, and every script ends with
 * `process.exit`, so there is nothing to unlock by hand.
 */

import { panic } from "better-result";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import { runUnderCorpusSchemaLane } from "@/api/db/corpus-schema-lane";
import type { rootDb as rootDatabase, Transaction } from "@/api/db/root";
import { logger } from "@/api/lib/observability/logger";

/**
 * The lane's advisory-lock key, as the `(int, int)` form of
 * `pg_advisory_lock`. The two halves name the domain and the lane so a reader
 * of `pg_locks` can tell it from the resolver's graph lock.
 */
export const CASE_LAW_MAINTENANCE_LANE = {
  domain: "case_law",
  lane: "maintenance",
} as const;

/** Waits longer than this are logged so a stuck pass is visible. */
export const MAINTENANCE_LANE_WAIT_LOG_MS = 30_000;

/** What `execute` resolves to for a row shape, as the drizzle instance types it. */
type ExecuteResult<TRow extends Record<string, unknown>> = Awaited<
  ReturnType<typeof rootDatabase.execute<TRow>>
>;

/** A root-connection handle: the subset scripts use of the drizzle instance. */
export type CaseLawRootHandle = {
  execute: <TRow extends Record<string, unknown> = Record<string, unknown>>(
    query: SQLWrapper | string,
  ) => PromiseLike<ExecuteResult<TRow>>;
  transaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
};

/** A transaction runner that sets the ingestion role, as the pipeline uses. */
export type CaseLawIngestionHandle = <T>(
  fn: (tx: Transaction) => Promise<T>,
) => Promise<T>;

/**
 * What either door hands a script. The lane's `rootDb` is the full drizzle
 * instance; the read-only door's is the narrow handle. A script with both a
 * plan and an apply mode writes its body against the narrow shape, which
 * both satisfy.
 */
export type CaseLawScriptHandles = {
  rootDb: CaseLawRootHandle;
  ingestionDb: CaseLawIngestionHandle;
};

/**
 * The write door's handles. Its `rootDb` is the narrow handle, every
 * transaction of which holds the corpus schema lane shared (see
 * `db/corpus-schema-lane.ts`): a root writer would otherwise slip past the
 * lane an upgrade drains, and race its DDL the way the workers used to.
 */
export type CaseLawWriteHandles = {
  rootDb: CaseLawRootHandle;
  ingestionDb: CaseLawIngestionHandle;
};

/** The held lane: what `holdCaseLawMaintenanceLane` returns. */
export type MaintenanceLaneHold = {
  /** Releases the lane and closes its connection. */
  release: () => Promise<void>;
  /** How long the lane was contended before this session held it. */
  waitedMs: number;
};

export type MaintenanceLaneSession = CaseLawWriteHandles & MaintenanceLaneHold;

/**
 * The two members the lane needs from its lock connection. Structural, so a
 * test can hand in a fake without importing Bun's client type.
 */
export type MaintenanceLaneSql = {
  unsafe: (
    statement: string,
    values?: readonly string[],
  ) => PromiseLike<readonly Record<string, unknown>[]>;
  end: () => Promise<void>;
};

type HoldLaneOptions = {
  /** Lock connection override for tests; scripts open one on DATABASE_URL. */
  sql?: MaintenanceLaneSql;
  /** Clock override for tests. */
  now?: () => number;
};

// Read lazily, not at import: the env and root modules connect on load, and a
// test that only exercises the session logic must import this module without
// an environment.
const openLaneConnection = async (): Promise<MaintenanceLaneSql> => {
  const { envBase } = await import("@/api/env-base");
  return new SQL({ url: envBase.DATABASE_URL, max: 1 });
};

/**
 * The root handle with every transaction under the shared corpus schema
 * lane. `execute` outside a transaction runs inside one, so there is no path
 * around the lane.
 */
const laneRootHandle = (rootDb: typeof rootDatabase): CaseLawRootHandle => {
  const transaction = async <T>(
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> =>
    await runUnderCorpusSchemaLane({ database: rootDb, work: fn });
  return {
    transaction,
    execute: async <TRow extends Record<string, unknown>>(
      query: SQLWrapper | string,
    ) => await transaction(async (tx) => await tx.execute<TRow>(query)),
  };
};

const loadWriteHandles = async (): Promise<CaseLawWriteHandles> => {
  const { rlsDb, rootDb } = await import("@/api/db/root");
  const { createIngestionDb } = await import("@/api/db/scoped");
  return {
    rootDb: laneRootHandle(rootDb),
    ingestionDb: createIngestionDb(rlsDb),
  };
};

/**
 * Take the lane on a dedicated connection and hold it until released or the
 * process ends. The lock half of `enterCaseLawMaintenanceLane`, separate so
 * its session semantics can be exercised without a database.
 */
export const holdCaseLawMaintenanceLane = async ({
  sql: providedSql,
  now = Date.now,
}: HoldLaneOptions = {}): Promise<MaintenanceLaneHold> => {
  const lock = providedSql ?? (await openLaneConnection());
  const startedAt = now();
  // One warning while still waiting, so an operator watching the log learns
  // the pass is queued behind another rather than hung.
  const warnTimer = setTimeout(() => {
    logger.warn("case_law.maintenance_lane.waiting", {
      "maintenanceLane.waitMs": now() - startedAt,
    });
  }, MAINTENANCE_LANE_WAIT_LOG_MS);
  try {
    await lock.unsafe("SELECT pg_advisory_lock(hashtext($1), hashtext($2))", [
      CASE_LAW_MAINTENANCE_LANE.domain,
      CASE_LAW_MAINTENANCE_LANE.lane,
    ]);
  } finally {
    clearTimeout(warnTimer);
  }
  const waitedMs = now() - startedAt;
  if (waitedMs >= MAINTENANCE_LANE_WAIT_LOG_MS) {
    logger.info("case_law.maintenance_lane.acquired", {
      "maintenanceLane.waitMs": waitedMs,
    });
  }
  return {
    waitedMs,
    release: async () => {
      const rows = await lock.unsafe(
        "SELECT pg_advisory_unlock(hashtext($1), hashtext($2)) AS released",
        [CASE_LAW_MAINTENANCE_LANE.domain, CASE_LAW_MAINTENANCE_LANE.lane],
      );
      const released = rows.at(0)?.["released"];
      if (released !== true) {
        panic("Maintenance lane was not held by this session at release");
      }
      await lock.end();
    },
  };
};

/**
 * Hold the maintenance lane for the rest of this process and receive the
 * write-capable handles.
 *
 * Call it before the script's first database statement. It blocks until any
 * other pass has finished. Release is only needed by tests; a script's
 * `process.exit` ends the session and the lock with it.
 */
export const enterCaseLawMaintenanceLane =
  async (): Promise<MaintenanceLaneSession> => {
    const hold = await holdCaseLawMaintenanceLane();
    const handles = await loadWriteHandles();
    return { ...handles, ...hold };
  };

type ReadOnlySessionOptions = {
  /** Handle override for tests. */
  handles?: CaseLawScriptHandles;
};

/**
 * Wrap both handles so every transaction is `READ ONLY`. `execute` outside a
 * transaction runs inside one, so there is no path around the setting.
 */
export const readOnlyHandles = ({
  rootDb,
  ingestionDb,
}: CaseLawScriptHandles): CaseLawScriptHandles => {
  const readOnlyTransaction = async <T>(
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> =>
    await rootDb.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      return await fn(tx);
    });
  return {
    rootDb: {
      transaction: readOnlyTransaction,
      execute: async <TRow extends Record<string, unknown>>(
        query: SQLWrapper | string,
      ) =>
        await readOnlyTransaction(async (tx) => await tx.execute<TRow>(query)),
    },
    ingestionDb: async (fn) =>
      await ingestionDb(async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        return await fn(tx);
      }),
  };
};

/**
 * Handles for a pass that only reads. No lane is taken, so a long report or
 * planning run never blocks a writer; the `READ ONLY` transactions are what
 * make that claim true rather than trusted.
 */
export const openCaseLawReadOnlySession = async ({
  handles,
}: ReadOnlySessionOptions = {}): Promise<CaseLawScriptHandles> =>
  readOnlyHandles(handles ?? (await loadWriteHandles()));
