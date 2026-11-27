import { panic, Result } from "better-result";
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
 * A cancellable job enters with a named mode instead. `bounded` is an
 * operator pass: it waits in the server's lock queue, in arrival order, for
 * up to its budget and then refuses naming the holder. `periodic` is a
 * scheduled tick: it tries once and skips a held lane, so a tick never holds
 * the lane ahead of a queued operator pass.
 *
 * This is a different lock from the citation-graph transaction owner. That one
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
import type { ReservedSQL } from "bun";
import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";

import { Temporal } from "@stll/time";

import { runUnderCorpusSchemaLane } from "@/api/db/corpus-schema-lane";
import {
  positiveDedicatedTimeoutMilliseconds,
  setDedicatedLockTimeout,
  setDedicatedStatementTimeout,
} from "@/api/db/dedicated-connection-timeouts";
import type { rootDb as rootDatabase, Transaction } from "@/api/db/root";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

/**
 * The lane's advisory-lock key, as the `(int, int)` form of
 * `pg_advisory_lock`. The two halves name the domain and the lane so a reader
 * of `pg_locks` can tell it from the resolver's graph lock.
 */
export const CASE_LAW_MAINTENANCE_LANE = {
  domain: "case_law",
  lane: "maintenance",
} as const;

/** The one blocking acquisition, shared by the session door and bounded passes. */
const LANE_LOCK_STATEMENT =
  "SELECT pg_advisory_lock(hashtext($1), hashtext($2))";

/** Waits longer than this are logged so a stuck pass is visible. */
const MAINTENANCE_LANE_WAIT_LOG_MS = 30_000;

/** Explicit object mode returns one array of rows, independent of driver raw envelopes. */
type ExecuteResult<TRow extends Record<string, unknown>> = TRow[];

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
type MaintenanceLaneSql = {
  unsafe: (
    statement: string,
    values?: readonly string[],
  ) => PromiseLike<readonly Record<string, unknown>[]>;
  end: () => Promise<void>;
};

type HoldLaneOptions = {
  /** Lock connection override for tests; scripts open one on DATABASE_URL. */
  sql?: MaintenanceLaneSql;
  /** Connection admission override for tests. */
  openConnection?: () => Promise<MaintenanceLaneSql>;
  /** Clock override for tests. */
  now?: () => number;
};

// Read lazily, not at import: the env and root modules connect on load, and a
// test that only exercises the session logic must import this module without
// an environment.
const openLaneConnection = async (): Promise<MaintenanceLaneSql> => {
  const { envBase } = await import("@/api/env-base");
  const { openMaintenanceSql } =
    await import("@/api/db/long-running-connection");
  return await openMaintenanceSql(envBase.DATABASE_URL);
};

/**
 * The root handle with every transaction under the shared corpus schema
 * lane. `execute` outside a transaction runs inside one, so there is no path
 * around the lane.
 */
type CaseLawSchemaLaneHandleOptions = {
  signal?: AbortSignal;
  laneWaitMs?: number;
  /** Test seam: how a refused try waits before the next. */
  sleep?: (ms: number) => Promise<void>;
};

export const caseLawRootHandleUnderCorpusSchemaLane = (
  rootDb: typeof rootDatabase,
  options: CaseLawSchemaLaneHandleOptions = {},
): CaseLawRootHandle => {
  const transaction = async <T>(
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> =>
    await runUnderCorpusSchemaLane({ database: rootDb, work: fn, ...options });
  return {
    transaction,
    execute: async <TRow extends Record<string, unknown>>(
      query: SQLWrapper | string,
    ) =>
      await transaction(async (tx) => await tx.execute<TRow>(query, "objects")),
  };
};

const loadWriteHandles = async (): Promise<CaseLawWriteHandles> => {
  const { rlsDb, rootDb } = await import("@/api/db/root");
  const { assertDatabaseLoginPosture } =
    await import("@/api/lib/db/assert-database-login-posture");
  await assertDatabaseLoginPosture(rootDb);
  const { createIngestionDb } = await import("@/api/db/scoped");
  return {
    rootDb: caseLawRootHandleUnderCorpusSchemaLane(rootDb),
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
  openConnection = openLaneConnection,
  now = () => Temporal.Now.instant().epochMilliseconds,
}: HoldLaneOptions = {}): Promise<MaintenanceLaneHold> => {
  const { logger } = await import("@/api/lib/observability/logger");
  const startedAt = now();
  // One warning while still waiting, so an operator watching the log learns
  // the pass is queued behind another rather than hung.
  const warnTimer = setTimeout(() => {
    logger.warn("case_law.maintenance_lane.waiting", {
      "maintenanceLane.waitMs": now() - startedAt,
    });
  }, MAINTENANCE_LANE_WAIT_LOG_MS);
  let lock: MaintenanceLaneSql | undefined;
  let acquisition: "waiting" | "held" = "waiting";
  try {
    lock = providedSql ?? (await openConnection());
    await lock.unsafe(LANE_LOCK_STATEMENT, [
      CASE_LAW_MAINTENANCE_LANE.domain,
      CASE_LAW_MAINTENANCE_LANE.lane,
    ]);
    acquisition = "held";
  } finally {
    clearTimeout(warnTimer);
    if (lock && acquisition === "waiting") {
      await lock.end();
    }
  }
  const heldLock = lock;
  const waitedMs = now() - startedAt;
  if (waitedMs >= MAINTENANCE_LANE_WAIT_LOG_MS) {
    logger.info("case_law.maintenance_lane.acquired", {
      "maintenanceLane.waitMs": waitedMs,
    });
  }
  return {
    waitedMs,
    release: async () => {
      try {
        const rows = await heldLock.unsafe(
          "SELECT pg_advisory_unlock(hashtext($1), hashtext($2)) AS released",
          [CASE_LAW_MAINTENANCE_LANE.domain, CASE_LAW_MAINTENANCE_LANE.lane],
        );
        const released = rows.at(0)?.["released"];
        if (released !== true) {
          panic("Maintenance lane was not held by this session at release");
        }
      } finally {
        await heldLock.end();
      }
    },
  };
};

type MaintenanceCleanupOptions = {
  timeoutMs: number;
  queryTimeoutMs: number;
};

/** Recovery outlives a cancelled job and retries schema admission on fresh sessions. */
export const createCaseLawMaintenanceCleanupHandles = async ({
  timeoutMs,
  queryTimeoutMs,
}: MaintenanceCleanupOptions): Promise<CaseLawScriptHandles> => {
  const [
    { withLongRunningConnection },
    { createIngestionDb, markRlsDatabase },
  ] = await Promise.all([
    import("@/api/db/long-running-connection"),
    import("@/api/db/scoped"),
  ]);
  const transaction: CaseLawRootHandle["transaction"] = async (work) => {
    const signal = AbortSignal.timeout(timeoutMs);
    return await withLongRunningConnection(
      { statementTimeout: queryTimeoutMs, lockTimeout: queryTimeoutMs, signal },
      async ({ db }) =>
        await runUnderCorpusSchemaLane({
          database: db,
          laneWaitMs: timeoutMs,
          sleep: async (milliseconds) =>
            await sleep(milliseconds, undefined, { signal }),
          work: async (tx) => {
            signal.throwIfAborted();
            return await work(tx);
          },
        }),
    );
  };
  return {
    rootDb: {
      transaction,
      execute: async <TRow extends Record<string, unknown>>(
        query: SQLWrapper | string,
      ) =>
        await transaction(
          async (tx) => await tx.execute<TRow>(query, "objects"),
        ),
    },
    ingestionDb: createIngestionDb(markRlsDatabase({ transaction }), {
      laneWaitMs: timeoutMs,
    }),
  };
};

/** Who holds the lane, read from the catalog: enough to find that pass. */
type MaintenanceLaneHolder = {
  pid: number;
  applicationName: string | null;
  backendStart: string | null;
  clientAddr: string | null;
};

/** A scoped pass either ran its work or found the lane held. */
type MaintenanceLaneOutcome<T> =
  | { status: "ran"; value: T }
  | { status: "busy"; holder: MaintenanceLaneHolder | null };

type ScopedMaintenanceLaneBudget<T> = {
  /** Cancels the lane wait and the work alike. */
  signal: AbortSignal;
  /** Per statement once the lane is held; never the lane wait itself. */
  statementTimeout: number;
  lockTimeout: number;
  work: (handles: CaseLawScriptHandles) => Promise<T>;
};

/**
 * An operator pass. It waits for the lane in the server's lock queue, so
 * waiters are served in arrival order and a periodic tick cannot slip in
 * ahead, and refuses once `laneWaitMs` has passed, so a write never queues
 * for hours behind a long pass.
 */
type BoundedMaintenanceLaneOptions<T> = ScopedMaintenanceLaneBudget<T> & {
  mode: "bounded";
  /** How long the pass waits for the lane, counted from its first try. */
  laneWaitMs: number;
  /** How long the work may hold the lane once granted; aborts it after. */
  workTimeoutMs: number;
};

/**
 * A scheduled tick. It tries the lane once and skips a held lane, since the
 * next tick catches up; it never queues, so it never holds the lane ahead of
 * an operator pass waiting for it.
 */
type PeriodicMaintenanceLaneOptions<T> = ScopedMaintenanceLaneBudget<T> & {
  mode: "periodic";
};

type ScopedMaintenanceLaneOptions<T> =
  BoundedMaintenanceLaneOptions<T> | PeriodicMaintenanceLaneOptions<T>;

/** The lane wait's statement budget beyond its lock budget, so `lock_timeout` fires first. */
const LANE_WAIT_STATEMENT_MARGIN_MS = 5000;

const LANE_KEY = [
  CASE_LAW_MAINTENANCE_LANE.domain,
  CASE_LAW_MAINTENANCE_LANE.lane,
] as const;

// The `(int, int)` advisory form stores its halves in classid and objid, with
// objsubid 2. Catalog reads only; the activity columns of another role's
// session read as null without pg_read_all_stats.
const LANE_HOLDER_QUERY = `SELECT l.pid,
       a.application_name,
       a.backend_start::text AS backend_start,
       host(a.client_addr) AS client_addr
  FROM pg_locks l
  LEFT JOIN pg_stat_activity a ON a.pid = l.pid
 WHERE l.locktype = 'advisory'
   AND l.granted
   AND l.database = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database())
   AND l.classid = hashtext($1)::oid
   AND l.objid = hashtext($2)::oid
   AND l.objsubid = 2
 LIMIT 1`;

type LaneHolderRow = {
  pid: number;
  application_name: string | null;
  backend_start: string | null;
  client_addr: string | null;
};

type LaneConnection = Pick<ReservedSQL, "unsafe" | "begin">;

const readLaneHolder = async (
  connection: LaneConnection,
): Promise<MaintenanceLaneHolder | null> => {
  const row = (
    await connection.unsafe<LaneHolderRow[]>(LANE_HOLDER_QUERY, [...LANE_KEY])
  ).at(0);
  return row === undefined
    ? null
    : {
        pid: row.pid,
        applicationName:
          row.application_name === "" ? null : row.application_name,
        backendStart: row.backend_start,
        clientAddr: row.client_addr,
      };
};

/** One phrase naming the holder, for a refusal an operator reads. */
export const describeMaintenanceLaneHolder = (
  holder: MaintenanceLaneHolder | null,
): string => {
  if (holder === null) {
    return "a session that has since released it";
  }
  const application =
    holder.applicationName === null ? "" : ` (${holder.applicationName})`;
  const started =
    holder.backendStart === null ? "" : `, connected ${holder.backendStart}`;
  const client = holder.clientAddr === null ? "" : ` from ${holder.clientAddr}`;
  return `pid ${holder.pid}${application}${started}${client}`;
};

const holderAttributes = (holder: MaintenanceLaneHolder | null) =>
  holder === null
    ? { "maintenanceLane.holderPid": null }
    : {
        "maintenanceLane.holderPid": holder.pid,
        "maintenanceLane.holderApplication": holder.applicationName,
        "maintenanceLane.holderBackendStart": holder.backendStart,
        "maintenanceLane.holderClientAddr": holder.clientAddr,
      };

/**
 * Takes the lane as one transaction with its own LOCAL budgets, so the wait
 * outlasts the session's statement budget and the work after it runs under
 * that budget unchanged. A session-level advisory lock outlives the
 * transaction that took it.
 */
const lockLaneWithin = async (
  connection: LaneConnection,
  waitMs: number,
): Promise<void> => {
  await connection.begin(async (tx) => {
    const execute = async (statement: string) =>
      await tx.unsafe<unknown[]>(statement);
    await setDedicatedLockTimeout(execute, waitMs);
    await setDedicatedStatementTimeout(
      execute,
      waitMs + LANE_WAIT_STATEMENT_MARGIN_MS,
    );
    await tx.unsafe<unknown[]>(LANE_LOCK_STATEMENT, [...LANE_KEY]);
  });
};

type LaneAcquisition =
  { status: "held" } | { status: "busy"; holder: MaintenanceLaneHolder | null };

type WaitForLaneOptions = {
  connection: LaneConnection;
  laneWaitMs: number;
  queuedBehind: MaintenanceLaneHolder | null;
  startedAt: number;
  now: () => number;
};

/** Waits in the server's lock queue until granted or the budget runs out. */
const waitForLane = async ({
  connection,
  laneWaitMs,
  queuedBehind,
  startedAt,
  now,
}: WaitForLaneOptions): Promise<LaneAcquisition> => {
  const remainingMs = Math.floor(laneWaitMs - (now() - startedAt));
  if (remainingMs <= 0) {
    return { status: "busy", holder: await readLaneHolder(connection) };
  }
  const { logger } = await import("@/api/lib/observability/logger");
  // One warning while still queued, naming the pass this one waits behind.
  const warnTimer = setTimeout(() => {
    logger.warn("case_law.maintenance_lane.waiting", {
      "maintenanceLane.waitMs": now() - startedAt,
      ...holderAttributes(queuedBehind),
    });
  }, MAINTENANCE_LANE_WAIT_LOG_MS);
  try {
    const waited = await Result.tryPromise({
      try: async () => {
        await lockLaneWithin(connection, remainingMs);
      },
      catch: (cause) =>
        cause instanceof Error
          ? cause
          : new Error("Maintenance lane wait failed", { cause }),
    });
    if (waited.isErr()) {
      return isPgError(waited.error, PG_ERROR.LOCK_NOT_AVAILABLE)
        ? { status: "busy", holder: await readLaneHolder(connection) }
        : await Promise.reject(waited.error);
    }
  } finally {
    clearTimeout(warnTimer);
  }
  const waitedMs = now() - startedAt;
  if (waitedMs >= MAINTENANCE_LANE_WAIT_LOG_MS) {
    logger.info("case_law.maintenance_lane.acquired", {
      "maintenanceLane.waitMs": waitedMs,
    });
  }
  return { status: "held" };
};

type AcquireScopedLaneOptions = {
  connection: LaneConnection;
  mode: ScopedMaintenanceLaneOptions<unknown>["mode"];
  laneWaitMs: number;
  now: () => number;
};

/** The wait budget counts from the first try, never connection admission. */
const acquireScopedLane = async ({
  connection,
  mode,
  laneWaitMs,
  now,
}: AcquireScopedLaneOptions): Promise<LaneAcquisition> => {
  const startedAt = now();
  const acquired = (
    await connection.unsafe<{ acquired: boolean }[]>(
      "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired",
      [...LANE_KEY],
    )
  ).at(0)?.acquired;
  if (acquired === true) {
    return { status: "held" };
  }
  const holder = await readLaneHolder(connection);
  switch (mode) {
    case "periodic": {
      const { logger } = await import("@/api/lib/observability/logger");
      logger.info("case_law.maintenance_lane.skipped", {
        "maintenanceLane.outcome": "skipped: lane busy",
        ...holderAttributes(holder),
      });
      return { status: "busy", holder };
    }
    case "bounded":
      return await waitForLane({
        connection,
        laneWaitMs,
        queuedBehind: holder,
        startedAt,
        now,
      });
    default:
      mode satisfies never;
      return panic(`Unhandled maintenance lane mode: ${String(mode)}`);
  }
};

type ScopedLaneBudgets = {
  laneWaitMs: number;
  /** Null: the caller's signal alone bounds the work. */
  workTimeoutMs: number | null;
};

const scopedLaneBudgets = (
  options: ScopedMaintenanceLaneOptions<unknown>,
): ScopedLaneBudgets => {
  switch (options.mode) {
    case "bounded":
      return {
        laneWaitMs: positiveDedicatedTimeoutMilliseconds(
          options.laneWaitMs,
          "laneWaitMs",
        ),
        workTimeoutMs: positiveDedicatedTimeoutMilliseconds(
          options.workTimeoutMs,
          "workTimeoutMs",
        ),
      };
    case "periodic":
      return { laneWaitMs: 0, workTimeoutMs: null };
    default:
      options satisfies never;
      return panic("Unhandled maintenance lane mode");
  }
};

/** Cancellable jobs own their lock and scoped work on the same reserved session. */
const runScopedMaintenanceLane = async <T>(
  options: ScopedMaintenanceLaneOptions<T>,
): Promise<MaintenanceLaneOutcome<T>> => {
  const { signal: callerSignal, statementTimeout, lockTimeout, work } = options;
  callerSignal.throwIfAborted();
  const { laneWaitMs, workTimeoutMs } = scopedLaneBudgets(options);
  const now = () => Temporal.Now.instant().epochMilliseconds;
  // The work budget starts at the grant, so a long wait never shortens the
  // work and a quick grant never lengthens it.
  const workDeadline = new AbortController();
  const signal = AbortSignal.any([callerSignal, workDeadline.signal]);
  const [
    { withLongRunningConnection },
    { createIngestionDb, markRlsDatabase },
  ] = await Promise.all([
    import("@/api/db/long-running-connection"),
    import("@/api/db/scoped"),
  ]);
  return await withLongRunningConnection(
    { signal, statementTimeout, lockTimeout },
    async ({ db, connection }): Promise<MaintenanceLaneOutcome<T>> => {
      const acquisition = await acquireScopedLane({
        connection,
        mode: options.mode,
        laneWaitMs,
        now,
      });
      if (acquisition.status === "busy") {
        return acquisition;
      }
      const workTimer =
        workTimeoutMs === null
          ? undefined
          : setTimeout(() => {
              workDeadline.abort(
                new DOMException(
                  "Maintenance lane work outlived its budget",
                  "TimeoutError",
                ),
              );
            }, workTimeoutMs);
      // Indicators and role-scoped pipeline work cannot overlap transactions
      // on the one session that owns the maintenance lock.
      let pending = Promise.resolve();
      const queuedTransaction: CaseLawRootHandle["transaction"] = async (
        fn,
      ) => {
        const current = pending.then(async () => await db.transaction(fn));
        pending = Result.tryPromise(async () => await current).then(
          () => undefined,
        );
        return await current;
      };
      const queuedDatabase = { transaction: queuedTransaction };
      const transaction: CaseLawRootHandle["transaction"] = async (fn) => {
        signal.throwIfAborted();
        // The caller's lock budget bounds the lane wait too: a zero budget
        // would refuse even an uncontended grant once the try took any time.
        return await runUnderCorpusSchemaLane({
          database: queuedDatabase,
          laneWaitMs: lockTimeout,
          signal,
          work: async (tx) => {
            signal.throwIfAborted();
            const result = await fn(tx);
            signal.throwIfAborted();
            return result;
          },
        });
      };
      const rootDb: CaseLawRootHandle = {
        transaction,
        execute: async <TRow extends Record<string, unknown>>(
          query: SQLWrapper | string,
        ) =>
          await transaction(
            async (tx) => await tx.execute<TRow>(query, "objects"),
          ),
      };
      const scoped = createIngestionDb(markRlsDatabase(queuedDatabase), {
        laneWaitMs: lockTimeout,
        signal,
      });
      const ingestionDb: CaseLawIngestionHandle = async (fn) =>
        await scoped(async (tx) => {
          signal.throwIfAborted();
          const result = await fn(tx);
          signal.throwIfAborted();
          return result;
        });
      try {
        return { status: "ran", value: await work({ rootDb, ingestionDb }) };
      } finally {
        clearTimeout(workTimer);
      }
    },
  );
};

type MaintenanceLaneSessionOptions = {
  hold: () => Promise<MaintenanceLaneHold>;
  loadHandles: () => Promise<CaseLawWriteHandles>;
};

/** Ownership transfers to the caller only after initialization succeeds. */
export const createMaintenanceLaneSession = async ({
  hold,
  loadHandles,
}: MaintenanceLaneSessionOptions): Promise<MaintenanceLaneSession> => {
  const held = await hold();
  let ownership: "initializing" | "transferred" = "initializing";
  try {
    const handles = await loadHandles();
    ownership = "transferred";
    return { ...handles, ...held };
  } finally {
    if (ownership === "initializing") {
      await held.release();
    }
  }
};

/**
 * Operator calls wait for the lane. A bounded operator pass waits in the
 * lock queue within its budget; a periodic tick tries once and skips. Both
 * close their session on return.
 */
export function enterCaseLawMaintenanceLane(): Promise<MaintenanceLaneSession>;
export function enterCaseLawMaintenanceLane<T>(
  options: BoundedMaintenanceLaneOptions<T> | PeriodicMaintenanceLaneOptions<T>,
): Promise<MaintenanceLaneOutcome<T>>;
export async function enterCaseLawMaintenanceLane<T>(
  options?:
    BoundedMaintenanceLaneOptions<T> | PeriodicMaintenanceLaneOptions<T>,
): Promise<MaintenanceLaneSession | MaintenanceLaneOutcome<T>> {
  if (options !== undefined) {
    return await runScopedMaintenanceLane(options);
  }
  return await createMaintenanceLaneSession({
    hold: holdCaseLawMaintenanceLane,
    loadHandles: loadWriteHandles,
  });
}

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
        await readOnlyTransaction(
          async (tx) => await tx.execute<TRow>(query, "objects"),
        ),
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
