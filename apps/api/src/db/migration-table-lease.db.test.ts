import { panic } from "better-result";
import type { ReservedSQL } from "bun";
import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { readMigrationLockSources } from "../../../../scripts/check-migration-locks";
import { generateMigrationLockManifest } from "../../../../scripts/generate-migration-lock-manifest";
import { DEFAULT_LEASE_MS } from "../lib/scheduler/lease-timing";
import {
  type GatedTestClientScope,
  withGatedTestClients,
} from "../tests/gated-test-database";
import {
  MIGRATION_LOCK_MANIFEST_FILE,
  pendingMigrationLockTables,
} from "./migration-lock-manifest";
import { runMigrations } from "./migration-runner";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import { chatRunLogEntries } from "./schema/chat";
import {
  acquireJobTableLeases,
  ensureTableLeaseQueue,
  MigrationTableLeaseTimeoutError,
  releaseJobTableLeases,
  type TableLeaseEvent,
} from "./table-lease-queue";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const corpusFolder = path.resolve(import.meta.dir, "../../drizzle");
const LOCKING_MIGRATION = "20261029140700_chat_run_text_boundaries";
const NO_LOCK_MIGRATION =
  "20261027120001_matter_time_expense_retention_validate";
const requestedTable = getTableName(chatRunLogEntries);

const adapt = (connection: ReservedSQL): OnlineMigrationConnection => ({
  execute: async (query, parameters = []) => {
    await connection.unsafe(query, [...parameters]);
  },
  query: async (query, parameters = []) =>
    await connection.unsafe<unknown[]>(query, [...parameters]),
  release: () => connection.release(),
});

const withDatabase = async (
  work: (scope: GatedTestClientScope, url: string) => Promise<void>,
) => {
  const databaseUrl =
    process.env["DATABASE_URL"] ?? panic("DATABASE_URL is required");
  await withGatedTestClients(
    databaseUrl,
    async (scope) => await work(scope, databaseUrl),
  );
};

const withBundle = async (
  name: string,
  work: (folder: string, tables: string[]) => Promise<void>,
) => {
  const folder = mkdtempSync(
    path.join(tmpdir(), "stella-table-lease-migrations-"),
  );
  try {
    const source = readFileSync(
      path.join(corpusFolder, name, "migration.sql"),
      "utf-8",
    );
    mkdirSync(path.join(folder, name));
    writeFileSync(path.join(folder, name, "migration.sql"), source);
    const fullManifest = generateMigrationLockManifest(
      readMigrationLockSources(),
    );
    const entry =
      fullManifest.migrations[name] ?? panic(`Missing real migration ${name}`);
    const manifest = {
      version: fullManifest.version,
      migrations: { [name]: entry },
    };
    writeFileSync(
      path.join(folder, MIGRATION_LOCK_MANIFEST_FILE),
      JSON.stringify(manifest),
    );
    await work(folder, pendingMigrationLockTables(manifest, [name]));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};

const uniqueSchema = () =>
  `lease_runner_${Bun.randomUUIDv7().replaceAll("-", "")}`;

const runOnlineComplete = async () => ({ type: "complete" as const });

describe.skipIf(!enabled)("migration runner table lease admission", () => {
  test("a real pending ALTER waits before its first statement and reports the live holder on timeout", async () => {
    await withBundle(LOCKING_MIGRATION, async (migrationsFolder, tables) => {
      expect(tables).toContain(requestedTable);
      await withDatabase(async ({ openClient }, databaseUrl) => {
        const job = openClient();
        const connection = await openClient().sql.reserve();
        const migrationsSchema = uniqueSchema();
        const holderId = `scheduled-job:${Bun.randomUUIDv7()}`;
        const events: TableLeaseEvent[] = [];
        try {
          await ensureTableLeaseQueue({ connection: adapt(connection) });
          expect(
            await job.db.transaction(
              async (tx) =>
                await acquireJobTableLeases({
                  tx,
                  holderId,
                  tables: [requestedTable],
                  leaseMs: DEFAULT_LEASE_MS,
                }),
            ),
          ).toBe(true);
          const originalColumns = await job.sql.unsafe(
            "SELECT attname, atttypid, attnotnull, attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 ORDER BY attnum",
            [requestedTable],
          );
          expect(originalColumns.length).toBeGreaterThan(0);
          const error = await rejectionOf(
            runMigrations({
              connection,
              databaseUrl,
              migrationsFolder,
              migrationsSchema,
              ebs: { type: "disabled" },
              runOnline: runOnlineComplete,
              tableLeaseOptions: {
                waitMs: 0,
                emit: (event) => events.push(event),
              },
            }),
          );
          expect(error).toBeInstanceOf(MigrationTableLeaseTimeoutError);
          expect(error).toMatchObject({
            message: expect.stringContaining(holderId),
            holders: [{ holderId, ageMs: expect.any(Number) }],
          });
          expect(events.map(({ event }) => event)).toEqual([
            "migrate.table_lease_requested",
            "migrate.table_lease_timed_out",
            "migrate.table_lease_released",
          ]);
          expect(
            await job.sql.unsafe(
              `SELECT name FROM "${migrationsSchema}".__drizzle_migrations`,
            ),
          ).toHaveLength(0);
          expect(
            await job.sql.unsafe(
              "SELECT attname, atttypid, attnotnull, attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 ORDER BY attnum",
              [requestedTable],
            ),
          ).toEqual(originalColumns);
          expect(
            await job.sql.unsafe(
              "SELECT holder_id FROM scheduler_table_leases WHERE holder_kind = 'migration' AND table_name IN (SELECT jsonb_array_elements_text($1::text::jsonb))",
              [JSON.stringify(tables)],
            ),
          ).toHaveLength(0);
        } finally {
          await releaseJobTableLeases(job.db, holderId);
          await job.sql.unsafe(
            `DROP SCHEMA IF EXISTS "${migrationsSchema}" CASCADE`,
          );
          await connection.release();
        }
      });
    });
  });

  test("a malformed manifest is rejected before the runner creates its ledger schema", async () => {
    await withBundle(NO_LOCK_MIGRATION, async (migrationsFolder) => {
      writeFileSync(
        path.join(migrationsFolder, MIGRATION_LOCK_MANIFEST_FILE),
        JSON.stringify({ version: 99, migrations: {} }),
      );
      await withDatabase(async ({ openClient }, databaseUrl) => {
        const observer = openClient().sql;
        const connection = await openClient().sql.reserve();
        const migrationsSchema = uniqueSchema();
        try {
          const error = await rejectionOf(
            runMigrations({
              connection,
              databaseUrl,
              migrationsFolder,
              migrationsSchema,
              ebs: { type: "disabled" },
              runOnline: runOnlineComplete,
            }),
          );
          expect(error).toMatchObject({
            message: expect.stringContaining(
              "Migration table lock manifest is malformed",
            ),
          });
          expect(
            await observer.unsafe(
              "SELECT nspname FROM pg_namespace WHERE nspname = $1",
              [migrationsSchema],
            ),
          ).toHaveLength(0);
        } finally {
          await connection.release();
        }
      });
    });
  });

  test("a real pending migration without relation locks applies while a job holds its table", async () => {
    await withBundle(NO_LOCK_MIGRATION, async (migrationsFolder, tables) => {
      expect(tables).toEqual([]);
      await withDatabase(async ({ openClient }, databaseUrl) => {
        const job = openClient();
        const connection = await openClient().sql.reserve();
        const migrationsSchema = uniqueSchema();
        const holderId = `unrelated-job:${Bun.randomUUIDv7()}`;
        const events: TableLeaseEvent[] = [];
        try {
          await ensureTableLeaseQueue({ connection: adapt(connection) });
          expect(
            await job.db.transaction(
              async (tx) =>
                await acquireJobTableLeases({
                  tx,
                  holderId,
                  tables: [requestedTable],
                  leaseMs: DEFAULT_LEASE_MS,
                }),
            ),
          ).toBe(true);
          const result = await runMigrations({
            connection,
            databaseUrl,
            migrationsFolder,
            migrationsSchema,
            ebs: { type: "disabled" },
            runOnline: runOnlineComplete,
            tableLeaseOptions: {
              waitMs: 0,
              emit: (event) => events.push(event),
            },
          });
          expect(result).toMatchObject({
            status: "applied",
            insertedNames: [NO_LOCK_MIGRATION],
          });
          expect(events).toEqual([]);
          expect(
            await job.sql.unsafe(
              `SELECT name FROM "${migrationsSchema}".__drizzle_migrations`,
            ),
          ).toMatchObject([{ name: NO_LOCK_MIGRATION }]);
          expect(
            await job.sql.unsafe(
              "SELECT holder_id FROM scheduler_table_leases WHERE holder_id = $1 AND expires_at > clock_timestamp()",
              [holderId],
            ),
          ).toHaveLength(1);
        } finally {
          await releaseJobTableLeases(job.db, holderId);
          await job.sql.unsafe(
            `DROP SCHEMA IF EXISTS "${migrationsSchema}" CASCADE`,
          );
          await connection.release();
        }
      });
    });
  });
});
