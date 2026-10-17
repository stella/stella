import { panic, TaggedError } from "better-result";
import type { ReservedSQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { getMigrationsToRun } from "drizzle-orm/migrator.utils";
import { migrate as pgCoreMigrate } from "drizzle-orm/pg-core";

import type { ConfiguredEbsConfiguration } from "../lib/db/ebs-signal-reader";
import migrationAliasInventory from "../lib/db/migration-alias-inventory.json";
import {
  assertMigrationHistory,
  LEDGER_AHEAD_NAME_LIMIT,
} from "../lib/db/migration-history";
import {
  planLedgerAdoption,
  validateLedger,
  validateRequires,
} from "../lib/db/migration-ledger";
import {
  CORPUS_SCHEMA_LANE_LOCK_STATEMENTS,
  CORPUS_SCHEMA_LANE_UNLOCK_SQL,
} from "./corpus-schema-lane";
import {
  DEFAULT_LOCK_RETRY_CONFIG,
  DEFAULT_LOCK_RETRY_RUNTIME,
  runLockRetryLadder,
} from "./lock-retry-ladder";
import type { LockRetryConfig, LockRetryRuntime } from "./lock-retry-ladder";
import { withMigrationLockTimeout } from "./migration-lock-timeout";
import { DEFAULT_MIGRATION_TIMING } from "./migration-timing";
import type { MigrationTiming } from "./migration-timing";
import { createOnlineIndexHold } from "./online-index-gate";
import type { OnlineIndexHoldRef } from "./online-index-gate";
import { openOnlineIndexObserver } from "./online-index-observer";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import { runOnlineMigrations } from "./online-migrations";
import { APPLICATION_RLS_ROLE_NAME } from "./role-names";
import { terminateReserved } from "./sql-close";

type LedgerRow = {
  id: number;
  hash: string;
  created_at: string | number | bigint | null;
  name: string | null;
};

type StaleBundleDecision =
  | { status: "ready" }
  | {
      status: "stale_bundle_noop" | "stale_bundle_refused";
      unknownCount: number;
      newestUnknownName: string | null;
      unknownNames: readonly string[];
      mismatchCount: number;
      mismatchedNames: readonly string[];
    };

// One policy boundary for receipts an older bundle cannot explain.
export const decideLedgerAheadPolicy = (
  violations: ReturnType<typeof validateLedger>,
): StaleBundleDecision => {
  const unknown = violations.filter(
    (violation) => violation.type === "unknown-name",
  );
  const mismatched = violations.filter(
    (violation) => violation.type === "hash-mismatch",
  );
  if (unknown.length === 0 && mismatched.length === 0) {
    return { status: "ready" };
  }
  const unknownNames = [...new Set(unknown.map(({ name }) => name))].toSorted();
  const mismatchedNames = [
    ...new Set(mismatched.map(({ name }) => name)),
  ].toSorted();
  return {
    status: [...unknown, ...mismatched].some(({ pending }) => pending)
      ? "stale_bundle_refused"
      : "stale_bundle_noop",
    unknownCount: unknown.length,
    newestUnknownName: unknownNames.at(-1) ?? null,
    unknownNames: unknownNames.slice(0, LEDGER_AHEAD_NAME_LIMIT),
    mismatchCount: mismatched.length,
    mismatchedNames: mismatchedNames.slice(0, LEDGER_AHEAD_NAME_LIMIT),
  };
};

// Keep the bootstrap statement identical to the former migrate.ts entrypoint.
const bootstrapRoleSql = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = '${APPLICATION_RLS_ROLE_NAME}'
  ) THEN
    BEGIN
      CREATE ROLE ${APPLICATION_RLS_ROLE_NAME} NOLOGIN;
    EXCEPTION
      WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = '${APPLICATION_RLS_ROLE_NAME}'
      AND (rolcanlogin OR rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'reserved RLS role ${APPLICATION_RLS_ROLE_NAME} must be NOLOGIN, NOSUPERUSER, and NOBYPASSRLS';
  END IF;
  IF CURRENT_USER <> '${APPLICATION_RLS_ROLE_NAME}'
     AND NOT pg_has_role(CURRENT_USER, '${APPLICATION_RLS_ROLE_NAME}', 'SET') THEN
    EXECUTE format(
      'GRANT ${APPLICATION_RLS_ROLE_NAME} TO %I WITH SET TRUE',
      CURRENT_USER
    );
  END IF;
END
$$;
`;

type AdoptionOptions = {
  database: ReturnType<typeof drizzle>;
  migrations: ReturnType<typeof readMigrationFiles>;
  migrationsSchema: string;
  migrationsTable: string;
};

const preflightAndAdopt = async ({
  database,
  migrations,
  migrationsSchema,
  migrationsTable,
}: AdoptionOptions) => {
  const constraintName = `${migrationsTable}_name_key`;
  return await database.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(
      sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(migrationsSchema)}`,
    );
    const tableRows = await tx.execute<{
      exists: boolean;
    }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = ${migrationsSchema}
          AND relation.relname = ${migrationsTable}
          AND relation.relkind IN ('r', 'p')
      ) AS "exists"
    `);
    const tableExists =
      tableRows.at(0)?.exists ?? panic("Missing ledger table check");
    if (tableExists) {
      await tx.execute(sql`
        LOCK TABLE ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)}
        IN ACCESS EXCLUSIVE MODE
      `);
    }

    const columns = tableExists
      ? await tx.execute<{ name: string; nullable: string }>(sql`
          SELECT column_name AS "name", is_nullable AS "nullable"
          FROM information_schema.columns
          WHERE table_schema = ${migrationsSchema} AND table_name = ${migrationsTable}
        `)
      : [];
    const hasName = columns.some(({ name }) => name === "name");
    const hasAppliedAt = columns.some(({ name }) => name === "applied_at");
    let rows: LedgerRow[] = [];
    if (tableExists && hasName) {
      rows = await tx.execute<LedgerRow>(sql`
        SELECT id, hash, created_at, name
        FROM ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)}
        ORDER BY id
      `);
    } else if (tableExists) {
      const unnamedRows = await tx.execute<Omit<LedgerRow, "name">>(sql`
        SELECT id, hash, created_at
        FROM ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)}
        ORDER BY id
      `);
      rows = unnamedRows.map(({ id, hash, created_at }) => ({
        id,
        hash,
        created_at,
        name: null,
      }));
    }

    const violations = validateLedger({
      receipts: rows,
      bundle: migrations,
      inventory: migrationAliasInventory,
    });
    const otherViolations = violations.filter(
      ({ type }) => type !== "unknown-name" && type !== "hash-mismatch",
    );
    if (otherViolations.length > 0) {
      panic(`Migration preflight: ${JSON.stringify(otherViolations)}`);
    }
    const staleBundle = decideLedgerAheadPolicy(violations);
    if (staleBundle.status !== "ready") {
      return staleBundle;
    }

    const decisions = planLedgerAdoption({
      rows,
      bundle: migrations,
      inventory: migrationAliasInventory,
    });
    const appliedNames = new Set(
      decisions.flatMap((decision) =>
        decision.type === "mapped" ? [decision.name] : [],
      ),
    );
    const dependencyViolations = validateRequires({
      bundle: migrations,
      appliedNames,
    });
    if (dependencyViolations.length > 0) {
      panic(`Migration preflight: ${JSON.stringify(dependencyViolations)}`);
    }

    if (!tableExists) {
      await tx.execute(sql`
        CREATE TABLE ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)} (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint,
          name text NOT NULL,
          applied_at timestamp with time zone DEFAULT now(),
          CONSTRAINT ${sql.identifier(constraintName)} UNIQUE (name)
        )
      `);
    } else {
      if (!hasName) {
        await tx.execute(sql`
          ALTER TABLE ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)}
          ADD COLUMN name text
        `);
      }
      if (!hasAppliedAt) {
        await tx.execute(sql`
          ALTER TABLE ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)}
          ADD COLUMN applied_at timestamp with time zone DEFAULT now()
        `);
      }
      const unnamedReceipts = decisions.flatMap((decision) =>
        decision.type === "mapped" && decision.receipt.name === null
          ? [sql`(${decision.receipt.id}::integer, ${decision.name}::text)`]
          : [],
      );
      if (unnamedReceipts.length > 0) {
        await tx.execute(sql`
          UPDATE ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)} AS ledger
          SET name = adopted.name, applied_at = NULL
          FROM (VALUES ${sql.join(unnamedReceipts, sql`, `)}) AS adopted(id, name)
          WHERE ledger.id = adopted.id
        `);
      }
      const nameColumn = columns.find(({ name }) => name === "name");
      if (nameColumn === undefined || nameColumn.nullable === "YES") {
        await tx.execute(sql`
          ALTER TABLE ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)}
          ALTER COLUMN name SET NOT NULL
        `);
      }
      const uniqueRows = await tx.execute<{
        exists: boolean;
      }>(sql`
        SELECT EXISTS (
            SELECT 1 FROM pg_catalog.pg_constraint migration_constraint
            JOIN pg_catalog.pg_class relation ON relation.oid = migration_constraint.conrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = ${migrationsSchema}
            AND relation.relname = ${migrationsTable}
              AND migration_constraint.conname = ${constraintName}
              AND migration_constraint.contype = 'u'
        ) AS "exists"
      `);
      const uniqueExists =
        uniqueRows.at(0)?.exists ?? panic("Missing ledger constraint check");
      if (!uniqueExists) {
        await tx.execute(sql`
          ALTER TABLE ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)}
          ADD CONSTRAINT ${sql.identifier(constraintName)} UNIQUE (name)
        `);
      }
    }

    const adoptedRows = await tx.execute<LedgerRow>(sql`
      SELECT id, hash, created_at, name
      FROM ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)}
      ORDER BY id
    `);
    return { status: "ready" as const, rows: adoptedRows };
  });
};

/** The schema phase shares the bounded ladder used by gated online DDL. */
export const MIGRATION_LOCK_WAIT_RETRY_BUDGET_MS =
  DEFAULT_LOCK_RETRY_CONFIG.budgetMs;

/** Why a pending set that lost a lock wait was not applied. */
export const MIGRATION_LOCK_WAIT_FAILURE = {
  /** Every attempt lost its lock wait. */
  exhausted: "exhausted",
  /** The run outlasted the rerun budget before losing a lock wait. */
  budgetSpent: "budget_spent",
  /** A split migration committed receipts, so a rerun is not the same run. */
  ledgerMoved: "ledger_moved",
} as const;

type MigrationLockWaitFailure =
  (typeof MIGRATION_LOCK_WAIT_FAILURE)[keyof typeof MIGRATION_LOCK_WAIT_FAILURE];

export class MigrationLockWaitError extends TaggedError(
  "MigrationLockWaitError",
)<{
  message: string;
  reason: MigrationLockWaitFailure;
  attempts: number;
  lockTimeoutMs: number;
  cause: unknown;
}> {}

type LockWaitRetry = LockRetryConfig & LockRetryRuntime;

const DEFAULT_LOCK_WAIT_RETRY: LockWaitRetry = {
  ...DEFAULT_LOCK_RETRY_CONFIG,
  ...DEFAULT_LOCK_RETRY_RUNTIME,
};

type ApplyPendingOptions = {
  apply: (lockTimeoutMs: number) => Promise<void>;
  /** Whether the ledger still equals the preflight read. */
  ledgerUnchanged: () => Promise<boolean>;
  retry: LockWaitRetry;
};

/**
 * Retry the whole transactional pending set. Split migrations may have committed
 * receipts before a lock failure; refusing a changed ledger keeps those retries
 * from replaying a different pending set.
 */
export const applyPendingRetryingLockWaits = async ({
  apply,
  ledgerUnchanged,
  retry,
}: ApplyPendingOptions): Promise<void> => {
  const outcome = await runLockRetryLadder({
    config: retry,
    now: retry.now,
    sleep: retry.sleep,
    random: retry.random,
    attempt: apply,
    beforeRetry: async ({ attempts, lockTimeoutMs, cause, pauseMs }) => {
      if (!(await ledgerUnchanged())) {
        throw new MigrationLockWaitError({
          message: `Migrations lost a lock wait after committing receipts on attempt ${String(attempts)}`,
          reason: MIGRATION_LOCK_WAIT_FAILURE.ledgerMoved,
          attempts,
          lockTimeoutMs,
          cause,
        });
      }
      process.stdout.write(
        `${JSON.stringify({
          event: "migrate.lock_wait_retry",
          level: "warn",
          attempt: attempts,
          attempts: retry.lockTimeoutsMs.length,
          lockTimeoutMs,
          delayMs: pauseMs,
        })}\n`,
      );
    },
  });
  if (outcome.type === "complete") {
    return;
  }
  throw new MigrationLockWaitError({
    message: `Migrations lost a lock wait after ${String(outcome.attempts)} attempts (${outcome.reason})`,
    reason: outcome.reason,
    attempts: outcome.attempts,
    lockTimeoutMs: outcome.lockTimeoutMs,
    cause: outcome.cause,
  });
};

const ledgerFingerprint = (rows: readonly LedgerRow[]) =>
  rows
    .map(
      ({ id, hash, created_at, name }) =>
        `${String(id)}:${hash}:${String(created_at)}:${String(name)}`,
    )
    .join(",");

type MigrationPhaseClock = {
  phase: "schema" | "online" | "done";
  startedAt: number;
  laneWaitMs: number | null;
};

/** The duration of the phase a failed run was in, reported before the error propagates. */
const emitFailedPhase = (
  timing: MigrationTiming,
  clock: MigrationPhaseClock,
  durationMs: number,
): void => {
  switch (clock.phase) {
    case "schema":
      timing.emit({
        event: "migrate.phase_duration",
        phase: "schema",
        durationMs,
        outcome: "failed",
        laneWaitMs: clock.laneWaitMs,
        appliedCount: null,
      });
      return;
    case "online":
      timing.emit({
        event: "migrate.phase_duration",
        phase: "online",
        durationMs,
        outcome: "failed",
      });
      return;
    case "done":
      return;
    default:
      clock.phase satisfies never;
      return panic("Migration phase clock is in an unknown phase");
  }
};

type RunMigrationsOptions = {
  connection: ReservedSQL;
  /** The database `connection` belongs to; index builds observe it apart. */
  databaseUrl: string;
  migrationsFolder: string;
  /** Resolved before the migrator connects; a missing one never gets here. */
  ebs: ConfiguredEbsConfiguration;
  migrationsSchema?: string;
  migrationsTable?: string;
  runOnline?: typeof runOnlineMigrations;
  onlineIndexHold?: OnlineIndexHoldRef;
  /** Test seam: lock retry configuration and runtime. */
  lockWaitRetry?: LockWaitRetry;
  /** Where phase and online step durations go; JSON lines on stdout otherwise. */
  timing?: MigrationTiming;
};

export const runMigrations = async ({
  connection,
  databaseUrl,
  migrationsFolder,
  ebs,
  migrationsSchema = "drizzle",
  migrationsTable = "__drizzle_migrations",
  runOnline = runOnlineMigrations,
  onlineIndexHold = createOnlineIndexHold(),
  lockWaitRetry = DEFAULT_LOCK_WAIT_RETRY,
  timing = DEFAULT_MIGRATION_TIMING,
}: RunMigrationsOptions) => {
  let laneHeld = false;
  // The phase in flight, so a failure reports the duration of the right one.
  const clock: MigrationPhaseClock = {
    phase: "schema",
    startedAt: timing.clock(),
    laneWaitMs: null,
  };
  const elapsedMs = () =>
    Math.max(0, Math.round(timing.clock() - clock.startedAt));
  // A terminated session already dropped its advisory locks; unlocking on the
  // closed connection would replace the monitoring error with a close error.
  const session: { state: "open" | "terminated" } = { state: "open" };
  try {
    await connection.unsafe(bootstrapRoleSql);
    const [liftTimeout, takeLane, restoreTimeout] =
      CORPUS_SCHEMA_LANE_LOCK_STATEMENTS;
    await connection.unsafe(liftTimeout);
    await connection.unsafe(takeLane);
    laneHeld = true;
    clock.laneWaitMs = elapsedMs();
    await connection.unsafe(restoreTimeout);

    const migrations = readMigrationFiles({ migrationsFolder });
    const database = drizzle({ client: connection });
    const preflight = await preflightAndAdopt({
      database,
      migrations,
      migrationsSchema,
      migrationsTable,
    });

    if (preflight.status !== "ready") {
      const event = {
        event: `migrate.${preflight.status}`,
        level: preflight.status === "stale_bundle_refused" ? "error" : "warn",
        unknownCount: preflight.unknownCount,
        newestUnknownName: preflight.newestUnknownName,
        unknownNames: preflight.unknownNames,
        mismatchCount: preflight.mismatchCount,
        mismatchedNames: preflight.mismatchedNames,
      };
      if (preflight.status === "stale_bundle_refused") {
        process.stderr.write(`${JSON.stringify(event)}\n`);
        panic(
          `Migration preflight: stale bundle has pending SQL${preflight.mismatchCount > 0 ? " (hash-mismatch)" : ""}`,
        );
      }
      process.stdout.write(`${JSON.stringify(event)}\n`);
      clock.phase = "done";
      timing.emit({
        event: "migrate.phase_duration",
        phase: "schema",
        durationMs: elapsedMs(),
        outcome: preflight.status,
        laneWaitMs: clock.laneWaitMs,
        appliedCount: 0,
      });
      return preflight;
    }

    // rc.4's pending selector reads names only; its row type requires a string timestamp.
    const predicted = getMigrationsToRun({
      localMigrations: migrations,
      dbMigrations: preflight.rows.map(({ id, hash, created_at, name }) => ({
        id,
        hash,
        created_at: String(created_at),
        name,
      })),
    });
    const readLedger = async () =>
      await database.execute<LedgerRow>(sql`
        SELECT id, hash, created_at, name
        FROM ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)}
        ORDER BY id
      `);
    const preflightFingerprint = ledgerFingerprint(preflight.rows);
    // Attempts share this connection, which holds the lane until the finally
    // below, so corpus writers stay drained between them.
    await applyPendingRetryingLockWaits({
      // Keep original identities and hashes while the runner owns queue bounds.
      apply: async (lockTimeoutMs) => {
        await connection.unsafe(
          `SET lock_timeout = '${String(lockTimeoutMs)}ms'`,
        );
        await pgCoreMigrate(
          migrations.map((migration) => ({
            ...migration,
            sql: migration.sql.map((statement) =>
              withMigrationLockTimeout(statement, lockTimeoutMs),
            ),
          })),
          database,
          {
            migrationsFolder,
            migrationsSchema,
            migrationsTable,
          },
        );
      },
      ledgerUnchanged: async () =>
        ledgerFingerprint(await readLedger()) === preflightFingerprint,
      retry: lockWaitRetry,
    });
    const postflightRows = await readLedger();
    const priorIds = new Set(preflight.rows.map(({ id }) => id));
    const inserted = postflightRows.filter(({ id }) => !priorIds.has(id));
    if (
      inserted.length !== predicted.length ||
      inserted.some(({ hash, name, created_at }, index) => {
        const expected = predicted.at(index);
        return (
          expected === undefined ||
          hash !== expected.hash ||
          name !== expected.name ||
          String(created_at) !== String(expected.folderMillis)
        );
      })
    ) {
      panic("Migration postflight receipts differ from Drizzle's prediction");
    }
    await assertMigrationHistory({
      context: "migrate",
      migrationsDir: migrationsFolder,
      queryAppliedRows: async () =>
        await database.execute<{ name: string | null; hash: string }>(sql`
          SELECT name, hash
          FROM ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)}
        `),
      remedy: "Migration completion requires every bundled migration hash.",
    });
    // The schema SQL is done. The online phase takes no ACCESS EXCLUSIVE lock
    // (concurrent index builds, validations, batched repairs), and an index
    // build on a corpus-sized table runs for many minutes: holding the lane
    // through it would stop every corpus writer for that long.
    await connection.unsafe(CORPUS_SCHEMA_LANE_UNLOCK_SQL);
    laneHeld = false;
    timing.emit({
      event: "migrate.phase_duration",
      phase: "schema",
      durationMs: elapsedMs(),
      outcome: "applied",
      laneWaitMs: clock.laneWaitMs,
      appliedCount: inserted.length,
    });
    clock.phase = "online";
    clock.startedAt = timing.clock();
    const onlineConnection: OnlineMigrationConnection = {
      terminate: async () => {
        session.state = "terminated";
        await terminateReserved(connection);
      },
      execute: async (query, params = []) => {
        await connection.unsafe(query, [...params]);
      },
      query: async (query, params = []) =>
        await connection.unsafe(query, [...params]),
      release: (): void => undefined,
    };
    const online = await runOnline(
      { reserve: async () => await Promise.resolve(onlineConnection) },
      {
        indexGate: { ebs, hold: onlineIndexHold },
        reserveObserver: async () => await openOnlineIndexObserver(databaseUrl),
        timing,
      },
    );
    clock.phase = "done";
    timing.emit({
      event: "migrate.phase_duration",
      phase: "online",
      durationMs: elapsedMs(),
      outcome: online.type,
    });
    const predictedNames = predicted.map(({ name }) => name);
    const insertedNames = inserted.map(({ name }) => name);
    if (online.type === "deferred") {
      return {
        status: "online_deferred" as const,
        step: online.step,
        retryAfterMs: online.retryAfterMs,
        predictedNames,
        insertedNames,
      };
    }
    return { status: "applied" as const, predictedNames, insertedNames };
  } catch (error: unknown) {
    emitFailedPhase(timing, clock, elapsedMs());
    throw error;
  } finally {
    if (laneHeld && session.state === "open") {
      await connection.unsafe(CORPUS_SCHEMA_LANE_UNLOCK_SQL);
    }
  }
};

type RunMigrationsResult = Awaited<ReturnType<typeof runMigrations>>;

type SettledMigrationsResult = Exclude<
  RunMigrationsResult,
  { status: "online_deferred" }
>;

type RunMigrationsUntilSettledOptions = RunMigrationsOptions & {
  sleep?: (milliseconds: number) => Promise<void>;
};

/**
 * Runs the migrator until its online phase completes. Every run releases the
 * corpus schema lane before its online phase, so corpus writers keep running
 * while an index builds or waits for health. A deferred index build ends the
 * run; the next run takes the lane again, re-reads the ledger (a newer bundle
 * may have moved it meanwhile), and resumes the online phase at the deferred
 * index. The hold spans the runs, so
 * a long one alerts once.
 */
export const runMigrationsUntilSettled = async ({
  sleep = Bun.sleep,
  onlineIndexHold = createOnlineIndexHold(),
  ...options
}: RunMigrationsUntilSettledOptions): Promise<SettledMigrationsResult> => {
  const result = await runMigrations({ ...options, onlineIndexHold });
  if (result.status !== "online_deferred") {
    return result;
  }
  process.stdout.write(
    `${JSON.stringify({
      event: "migrate.online_deferred",
      step: result.step,
      retryAfterMs: result.retryAfterMs,
    })}\n`,
  );
  await sleep(result.retryAfterMs);
  return await runMigrationsUntilSettled({
    ...options,
    sleep,
    onlineIndexHold,
  });
};
