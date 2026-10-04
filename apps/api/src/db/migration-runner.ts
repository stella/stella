import { panic, Result, TaggedError } from "better-result";
import type { ReservedSQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { getMigrationsToRun } from "drizzle-orm/migrator.utils";
import { migrate as pgCoreMigrate } from "drizzle-orm/pg-core";

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
import { isPgError, PG_ERROR } from "../lib/pg-error";
import {
  CORPUS_SCHEMA_LANE_LOCK_STATEMENTS,
  CORPUS_SCHEMA_LANE_UNLOCK_SQL,
} from "./corpus-schema-lane";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import { runOnlineMigrations } from "./online-migrations";
import { APPLICATION_RLS_ROLE_NAME } from "./role-names";

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

/**
 * Pauses between attempts of a pending set that lost a lock wait; one attempt
 * more than there are pauses. The lane drains corpus writers, but autovacuum
 * and sessions outside it can still hold a table lock past a migration's
 * `lock_timeout`: PostgreSQL cancels an autovacuum that blocks DDL only after
 * `deadlock_timeout`, which ties the repository's one-second `lock_timeout`.
 */
export const MIGRATION_LOCK_WAIT_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

/** Why a pending set that lost a lock wait was not applied. */
export const MIGRATION_LOCK_WAIT_FAILURE = {
  /** Every attempt lost its lock wait. */
  exhausted: "exhausted",
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
  cause: unknown;
}> {}

type LockWaitRetry = {
  delaysMs: readonly number[];
  sleep: (ms: number) => Promise<void>;
};

const DEFAULT_LOCK_WAIT_RETRY: LockWaitRetry = {
  delaysMs: MIGRATION_LOCK_WAIT_RETRY_DELAYS_MS,
  sleep: async (ms) => await Bun.sleep(ms),
};

type ApplyPendingOptions = {
  apply: () => Promise<void>;
  /** Whether the ledger still equals the preflight read. */
  ledgerUnchanged: () => Promise<boolean>;
  retry: LockWaitRetry;
};

/**
 * Applies the pending set, rerunning it whole while it fails on
 * `lock_not_available` and pauses remain. Drizzle applies the set in one
 * transaction, so a lost lock wait rolls every pending migration back and a
 * rerun is the same run. A migration that splits that transaction (the
 * concurrent-index protocol) can commit earlier receipts before the failure;
 * the ledger check refuses to rerun then, leaving the next migrate to plan
 * from a fresh preflight. Every other failure propagates unchanged.
 * Recursive so each attempt ends before the next begins.
 */
export const applyPendingRetryingLockWaits = async (
  { apply, ledgerUnchanged, retry }: ApplyPendingOptions,
  attempt = 1,
): Promise<void> => {
  const outcome = await Result.tryPromise({
    try: apply,
    catch: (cause) => cause,
  });
  if (Result.isOk(outcome)) {
    return;
  }
  const { error } = outcome;
  if (!isPgError(error, PG_ERROR.LOCK_NOT_AVAILABLE)) {
    throw error;
  }
  const delayMs = retry.delaysMs.at(attempt - 1);
  if (delayMs === undefined) {
    throw new MigrationLockWaitError({
      message: `Migrations lost a lock wait on each of ${String(attempt)} attempts`,
      reason: MIGRATION_LOCK_WAIT_FAILURE.exhausted,
      attempts: attempt,
      cause: error,
    });
  }
  if (!(await ledgerUnchanged())) {
    throw new MigrationLockWaitError({
      message: `Migrations lost a lock wait after committing receipts on attempt ${String(attempt)}`,
      reason: MIGRATION_LOCK_WAIT_FAILURE.ledgerMoved,
      attempts: attempt,
      cause: error,
    });
  }
  process.stdout.write(
    `${JSON.stringify({
      event: "migrate.lock_wait_retry",
      level: "warn",
      attempt,
      attempts: retry.delaysMs.length + 1,
      delayMs,
    })}\n`,
  );
  await retry.sleep(delayMs);
  await applyPendingRetryingLockWaits(
    { apply, ledgerUnchanged, retry },
    attempt + 1,
  );
};

const ledgerFingerprint = (rows: readonly LedgerRow[]) =>
  rows
    .map(
      ({ id, hash, created_at, name }) =>
        `${String(id)}:${hash}:${String(created_at)}:${String(name)}`,
    )
    .join(",");

type RunMigrationsOptions = {
  connection: ReservedSQL;
  migrationsFolder: string;
  migrationsSchema?: string;
  migrationsTable?: string;
  runOnline?: typeof runOnlineMigrations;
  /** Test seam: the pauses between lock-wait attempts and how to wait them. */
  lockWaitRetry?: LockWaitRetry;
};

export const runMigrations = async ({
  connection,
  migrationsFolder,
  migrationsSchema = "drizzle",
  migrationsTable = "__drizzle_migrations",
  runOnline = runOnlineMigrations,
  lockWaitRetry = DEFAULT_LOCK_WAIT_RETRY,
}: RunMigrationsOptions) => {
  let laneHeld = false;
  try {
    await connection.unsafe(bootstrapRoleSql);
    const [liftTimeout, takeLane, restoreTimeout] =
      CORPUS_SCHEMA_LANE_LOCK_STATEMENTS;
    await connection.unsafe(liftTimeout);
    await connection.unsafe(takeLane);
    laneHeld = true;
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
      // bun-sql's migrator calls this same function after reading files; passing
      // the preflight array keeps validation and execution on identical bytes.
      apply: async () => {
        await pgCoreMigrate(migrations, database, {
          migrationsFolder,
          migrationsSchema,
          migrationsTable,
        });
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
    const onlineConnection: OnlineMigrationConnection = {
      execute: async (query, params = []) => {
        await connection.unsafe(query, [...params]);
      },
      query: async (query, params = []) =>
        await connection.unsafe(query, [...params]),
      release: (): void => undefined,
    };
    await runOnline({
      reserve: async () => await Promise.resolve(onlineConnection),
    });
    return {
      status: "applied" as const,
      predictedNames: predicted.map(({ name }) => name),
      insertedNames: inserted.map(({ name }) => name),
    };
  } finally {
    if (laneHeld) {
      await connection.unsafe(CORPUS_SCHEMA_LANE_UNLOCK_SQL);
    }
  }
};
