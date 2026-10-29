import { panic, TaggedError } from "better-result";
import type { MaybePromise, ReservedSQL } from "bun";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { getMigrationsToRun } from "drizzle-orm/migrator.utils";
import { migrate as pgCoreMigrate } from "drizzle-orm/pg-core";

import { declareFingerprintFields } from "@stll/errors";

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
import {
  createMigrationLockTelemetry,
  observeMigrationLockAttempt,
} from "./migration-lock-observation";
import type { MigrationLockTelemetry } from "./migration-lock-observation";
import { withMigrationLockTimeout } from "./migration-lock-timeout";
import { DEFAULT_MIGRATION_TIMING } from "./migration-timing";
import type { MigrationTiming } from "./migration-timing";
import { createOnlineIndexHold } from "./online-index-gate";
import type { OnlineIndexHoldRef } from "./online-index-gate";
import { openOnlineIndexObserver } from "./online-index-observer";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import { runOnlineMigrations } from "./online-migrations";
import { APPLICATION_RLS_ROLE_NAME } from "./role-names";
import { createDatabase } from "./sql-client";
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
  database: ReturnType<typeof createDatabase>;
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
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

type LockWaitRetry = LockRetryConfig & LockRetryRuntime;

const DEFAULT_LOCK_WAIT_RETRY: LockWaitRetry = {
  ...DEFAULT_LOCK_RETRY_CONFIG,
  ...DEFAULT_LOCK_RETRY_RUNTIME,
};

type ApplyPendingOptions = {
  apply: (lockTimeoutMs: number) => Promise<void>;
  classifyLedger: () => Promise<MigrationLedgerProgress>;
  retry: LockWaitRetry;
};

export type MigrationLedgerProgress =
  | { status: "unchanged"; committedReceipts: 0 }
  | { status: "own"; committedReceipts: number }
  | { status: "foreign"; committedReceipts: 0 };

type ClassifyMigrationLedgerOptions = {
  preflightRows: readonly LedgerRow[];
  currentRows: readonly LedgerRow[];
  predicted: ReturnType<typeof getMigrationsToRun>;
};

const sameReceipt = (left: LedgerRow, right: LedgerRow) =>
  left.id === right.id &&
  left.hash === right.hash &&
  String(left.created_at) === String(right.created_at) &&
  left.name === right.name;

export const classifyMigrationLedger = ({
  preflightRows,
  currentRows,
  predicted,
}: ClassifyMigrationLedgerOptions): MigrationLedgerProgress => {
  const preflightById = new Map(preflightRows.map((row) => [row.id, row]));
  const currentById = new Map(currentRows.map((row) => [row.id, row]));
  if (
    currentById.size !== currentRows.length ||
    preflightRows.some((row) => {
      const current = currentById.get(row.id);
      return current === undefined || !sameReceipt(row, current);
    })
  ) {
    return { status: "foreign", committedReceipts: 0 };
  }

  const inserted = currentRows.filter(({ id }) => !preflightById.has(id));
  if (inserted.length === 0) {
    return { status: "unchanged", committedReceipts: 0 };
  }
  if (
    inserted.length > predicted.length ||
    inserted.some(({ hash, name, created_at }, index) => {
      const expected = predicted.at(index);
      return (
        expected === undefined ||
        name !== expected.name ||
        hash !== expected.hash ||
        String(created_at) !== String(expected.folderMillis)
      );
    })
  ) {
    return { status: "foreign", committedReceipts: 0 };
  }
  return { status: "own", committedReceipts: inserted.length };
};

type MigrationLedgerClassifierOptions = {
  preflightRows: readonly LedgerRow[];
  predicted: ReturnType<typeof getMigrationsToRun>;
  readLedger: () => Promise<readonly LedgerRow[]>;
};

const migrationLedgerClassifier =
  ({
    preflightRows,
    predicted,
    readLedger,
  }: MigrationLedgerClassifierOptions) =>
  async () =>
    classifyMigrationLedger({
      preflightRows,
      currentRows: await readLedger(),
      predicted,
    });

/**
 * Retry the whole pending set, including after this run committed a prefix of its
 * predicted receipts. Refuse a retry only when another writer added a receipt.
 */
export const applyPendingRetryingLockWaits = async ({
  apply,
  classifyLedger,
  retry,
}: ApplyPendingOptions): Promise<void> => {
  const outcome = await runLockRetryLadder({
    config: retry,
    now: retry.now,
    sleep: retry.sleep,
    random: retry.random,
    attempt: apply,
    beforeRetry: async ({ attempts, lockTimeoutMs, cause, pauseMs }) => {
      const ledgerProgress = await classifyLedger();
      if (ledgerProgress.status === "foreign") {
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
          committedReceipts: ledgerProgress.committedReceipts,
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

type ApplySchemaMigrationsOptions = ApplyPendingOptions & {
  connectionState?: () => "open" | "terminated";
  connection: {
    unsafe: (query: string) => PromiseLike<unknown>;
  };
};

export const applySchemaMigrationsRetryingLockWaits = async ({
  connection,
  connectionState,
  ...options
}: ApplySchemaMigrationsOptions): Promise<void> => {
  try {
    await applyPendingRetryingLockWaits(options);
  } finally {
    if (connectionState?.() !== "terminated") {
      await connection.unsafe("RESET lock_timeout");
    }
  }
};

type PrepareSchemaPhaseOptions = {
  readMigrations: typeof readMigrationFiles;
  connection: ReservedSQL;
  migrationsFolder: string;
  migrationsSchema: string;
  migrationsTable: string;
  onLaneAcquired: () => void;
};

const prepareSchemaPhase = async ({
  readMigrations,
  connection,
  migrationsFolder,
  migrationsSchema,
  migrationsTable,
  onLaneAcquired,
}: PrepareSchemaPhaseOptions) => {
  await connection.unsafe(bootstrapRoleSql);
  const [liftTimeout, takeLane, restoreTimeout] =
    CORPUS_SCHEMA_LANE_LOCK_STATEMENTS;
  await connection.unsafe(liftTimeout);
  await connection.unsafe(takeLane);
  onLaneAcquired();
  await connection.unsafe(restoreTimeout);

  const bundle = readMigrations({ migrationsFolder });
  const schemaDatabase = createDatabase({ client: connection });
  const adoption = await preflightAndAdopt({
    database: schemaDatabase,
    migrations: bundle,
    migrationsSchema,
    migrationsTable,
  });

  return {
    preflight: adoption,
    migrations: bundle,
    database: schemaDatabase,
  };
};

type VerifyMigrationReceiptsOptions = {
  database: ReturnType<typeof createDatabase>;
  readLedger: () => Promise<readonly LedgerRow[]>;
  preflightRows: readonly LedgerRow[];
  predicted: ReturnType<typeof getMigrationsToRun>;
  migrationsFolder: string;
  migrationsSchema: string;
  migrationsTable: string;
};

const verifyMigrationReceipts = async ({
  database,
  readLedger,
  preflightRows,
  predicted,
  migrationsFolder,
  migrationsSchema,
  migrationsTable,
}: VerifyMigrationReceiptsOptions) => {
  const postflightRows = await readLedger();
  const priorIds = new Set(preflightRows.map(({ id }) => id));
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
  return inserted;
};

const reportStalePreflight = (
  preflight: Exclude<StaleBundleDecision, { status: "ready" }>,
) => {
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
};

type MigrationPhaseClock = {
  phase: "schema" | "online" | "done";
  startedAt: number;
  laneWaitMs: number | null;
  retriesSpent: number;
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
        retriesSpent: clock.retriesSpent,
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
        retriesSpent: clock.retriesSpent,
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

type OnlineMigrationRunner = (
  ...args: Parameters<typeof runOnlineMigrations>
) => MaybePromise<Awaited<ReturnType<typeof runOnlineMigrations>>>;

type RunMigrationsOptions = {
  /** Local test templates replay existing cluster roles without changing source hashes. */
  readMigrations?: typeof readMigrationFiles;
  connection: ReservedSQL;
  /** The database `connection` belongs to; index builds observe it apart. */
  databaseUrl: string;
  migrationsFolder: string;
  /** Resolved before the migrator connects; a missing one never gets here. */
  ebs: ConfiguredEbsConfiguration;
  migrationsSchema?: string;
  migrationsTable?: string;
  runOnline?: OnlineMigrationRunner;
  onlineIndexHold?: OnlineIndexHoldRef;
  /** Test seam: lock retry configuration and runtime. */
  lockWaitRetry?: LockWaitRetry;
  /** Where phase and online step durations go; JSON lines on stdout otherwise. */
  timing?: MigrationTiming;
  lockTelemetry?: MigrationLockTelemetry;
  reserveSchemaObserver?: typeof openOnlineIndexObserver;
};

const migrationSessionCanUnlock = (
  laneHeld: boolean,
  sessionState: "open" | "terminated",
) => laneHeld && sessionState === "open";

type SchemaObservationOptions = {
  observer: OnlineMigrationConnection;
  connection: ReservedSQL;
  telemetry: MigrationLockTelemetry;
  cancelWork: () => Promise<void>;
};

const createSchemaObservation = async ({
  observer,
  connection,
  telemetry,
  cancelWork,
}: SchemaObservationOptions) => {
  const backend =
    (
      await connection.unsafe<{ pid: number }[]>(
        "SELECT pg_backend_pid() AS pid",
      )
    ).at(0) ?? panic("Missing migration backend pid");
  return async <T>(step: string, work: () => Promise<T>) =>
    await observeMigrationLockAttempt({
      observer,
      pid: backend.pid,
      phase: "schema",
      step,
      table: null,
      telemetry,
      work,
      cancelWork,
      outcome: () => "done",
    });
};

type ReservedOnlineConnectionOptions = {
  connection: ReservedSQL;
  session: { state: "open" | "terminated" };
};

const createReservedOnlineConnection = ({
  connection,
  session,
}: ReservedOnlineConnectionOptions): OnlineMigrationConnection => ({
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
});

export const runMigrations = async ({
  readMigrations = readMigrationFiles,
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
  lockTelemetry = createMigrationLockTelemetry(),
  reserveSchemaObserver = openOnlineIndexObserver,
}: RunMigrationsOptions) => {
  let laneHeld = false;
  const clock: MigrationPhaseClock = {
    phase: "schema",
    startedAt: timing.clock(),
    laneWaitMs: null,
    retriesSpent: 0,
  };
  const elapsedMs = () =>
    Math.max(0, Math.round(timing.clock() - clock.startedAt));
  const session: { state: "open" | "terminated" } = { state: "open" };
  let schemaObserver: OnlineMigrationConnection | undefined;
  const schemaRetriesAtStart = lockTelemetry.retriesSpent;
  let onlineRetriesAtStart = 0;
  try {
    schemaObserver = await reserveSchemaObserver(databaseUrl);
    const observeSchema = await createSchemaObservation({
      observer: schemaObserver,
      connection,
      telemetry: lockTelemetry,
      cancelWork: async () => {
        session.state = "terminated";
        await terminateReserved(connection);
      },
    });
    const { preflight, migrations, database } = await observeSchema(
      "schema.preflight",
      async () =>
        await prepareSchemaPhase({
          readMigrations,
          connection,
          migrationsFolder,
          migrationsSchema,
          migrationsTable,
          onLaneAcquired: () => {
            laneHeld = true;
            clock.laneWaitMs = elapsedMs();
          },
        }),
    );

    if (preflight.status !== "ready") {
      reportStalePreflight(preflight);
      clock.phase = "done";
      timing.emit({
        event: "migrate.phase_duration",
        phase: "schema",
        durationMs: elapsedMs(),
        retriesSpent: clock.retriesSpent,
        outcome: preflight.status,
        laneWaitMs: clock.laneWaitMs,
        appliedCount: 0,
      });
      return preflight;
    }

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
    await applySchemaMigrationsRetryingLockWaits({
      connection,
      connectionState: () => session.state,
      apply: async (lockTimeoutMs) => {
        await connection.unsafe(
          `SET lock_timeout = '${String(lockTimeoutMs)}ms'`,
        );
        await observeSchema(
          "schema.pending",
          async () =>
            await pgCoreMigrate(
              migrations.map((migration) => ({
                ...migration,
                sql: migration.sql.map((statement) =>
                  withMigrationLockTimeout(statement, lockTimeoutMs),
                ),
              })),
              database,
              { migrationsFolder, migrationsSchema, migrationsTable },
            ),
        );
      },
      classifyLedger: migrationLedgerClassifier({
        preflightRows: preflight.rows,
        predicted,
        readLedger,
      }),
      retry: lockWaitRetry,
    });
    clock.retriesSpent = lockTelemetry.retriesSpent - schemaRetriesAtStart;
    await schemaObserver.release();
    schemaObserver = undefined;
    const inserted = await verifyMigrationReceipts({
      database,
      readLedger,
      preflightRows: preflight.rows,
      predicted,
      migrationsFolder,
      migrationsSchema,
      migrationsTable,
    });
    await connection.unsafe(CORPUS_SCHEMA_LANE_UNLOCK_SQL);
    laneHeld = false;
    timing.emit({
      event: "migrate.phase_duration",
      phase: "schema",
      durationMs: elapsedMs(),
      retriesSpent: clock.retriesSpent,
      outcome: "applied",
      laneWaitMs: clock.laneWaitMs,
      appliedCount: inserted.length,
    });
    clock.phase = "online";
    onlineRetriesAtStart = lockTelemetry.retriesSpent;
    const onlineTiming: MigrationTiming = {
      ...timing,
      retriesSpent: () => lockTelemetry.retriesSpent,
    };
    clock.startedAt = timing.clock();
    const onlineConnection = createReservedOnlineConnection({
      connection,
      session,
    });
    const online = await runOnline(
      { reserve: async () => await Promise.resolve(onlineConnection) },
      {
        indexGate: { ebs, hold: onlineIndexHold, lockTelemetry },
        reserveObserver: async () => await openOnlineIndexObserver(databaseUrl),
        timing: onlineTiming,
      },
    );
    clock.retriesSpent = lockTelemetry.retriesSpent - onlineRetriesAtStart;
    clock.phase = "done";
    timing.emit({
      event: "migrate.phase_duration",
      phase: "online",
      durationMs: elapsedMs(),
      retriesSpent: clock.retriesSpent,
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
    const retriesAtStart =
      clock.phase === "online" ? onlineRetriesAtStart : schemaRetriesAtStart;
    clock.retriesSpent = lockTelemetry.retriesSpent - retriesAtStart;
    emitFailedPhase(timing, clock, elapsedMs());
    throw error;
  } finally {
    try {
      if (migrationSessionCanUnlock(laneHeld, session.state)) {
        await connection.unsafe(CORPUS_SCHEMA_LANE_UNLOCK_SQL);
      }
    } finally {
      await schemaObserver?.release();
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
  lockTelemetry = createMigrationLockTelemetry(),
  ...options
}: RunMigrationsUntilSettledOptions): Promise<SettledMigrationsResult> => {
  const result = await runMigrations({
    ...options,
    onlineIndexHold,
    lockTelemetry,
  });
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
    lockTelemetry,
  });
};
