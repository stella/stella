import { panic } from "better-result";
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
import type { MigrationDrainConfirmation } from "../env-migration";
import { parseMigrationDrainConfirmation } from "../env-migration";
import { DEFAULT_LEASE_MS } from "../lib/scheduler/lease-timing";
import { withGatedTestClients } from "../tests/gated-test-database";
import { MigrationSchedulerDrainRequired } from "./migration-cutover";
import type { MigrationCutoverEvent } from "./migration-cutover";
import {
  MIGRATION_LOCK_MANIFEST_FILE,
  pendingMigrationLockTables,
} from "./migration-lock-manifest";
import { runMigrations } from "./migration-runner";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import { schedulerTableLeases } from "./schema/table-leases";
import {
  acquireJobTableLeases,
  ensureTableLeaseQueue,
  releaseJobTableLeases,
  TABLE_LEASE_MIGRATION,
} from "./table-lease-queue";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const corpusFolder = path.resolve(import.meta.dir, "../../drizzle");
const NO_LOCK_MIGRATION =
  "20261027120001_matter_time_expense_retention_validate";
const ledgerSchema = "cutover_ledger";

type CutoverRunOptions = {
  confirmation?: MigrationDrainConfirmation;
  emit?: (event: MigrationCutoverEvent) => void;
};

const withCutoverFixture = async (
  migrationName: string,
  work: (fixture: {
    run: (options?: CutoverRunOptions) => ReturnType<typeof runMigrations>;
    query: (query: string) => PromiseLike<unknown[]>;
    seedRecentAdmission: () => Promise<void>;
    seedScheduler: () => Promise<void>;
  }) => Promise<void>,
) => {
  const databaseUrl =
    process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
  const folder = mkdtempSync(path.join(tmpdir(), "stella-cutover-"));
  try {
    mkdirSync(path.join(folder, migrationName));
    writeFileSync(
      path.join(folder, migrationName, "migration.sql"),
      readFileSync(path.join(corpusFolder, migrationName, "migration.sql")),
    );
    const manifest = generateMigrationLockManifest(readMigrationLockSources());
    const entry =
      manifest.migrations[migrationName] ?? panic("Missing real migration");
    if (migrationName === TABLE_LEASE_MIGRATION) {
      expect(
        pendingMigrationLockTables(manifest, [migrationName]).length,
      ).toBeGreaterThan(0);
    }
    writeFileSync(
      path.join(folder, MIGRATION_LOCK_MANIFEST_FILE),
      JSON.stringify({
        version: manifest.version,
        migrations: { [migrationName]: entry },
      }),
    );
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const admin = openClient().sql;
      const databaseName = `lease_cutover_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      const scratchUrl = new URL(databaseUrl);
      scratchUrl.pathname = `/${databaseName}`;
      try {
        await withGatedTestClients(
          scratchUrl.toString(),
          async ({ openClient: openScratch }) => {
            const { db, sql: client } = openScratch({ max: 2 });
            const connection = await openScratch().sql.reserve();
            const adapter = {
              execute: async (query, params = []) => {
                await connection.unsafe(query, [...params]);
              },
              query: async (query, params = []) =>
                await connection.unsafe<unknown[]>(query, [...params]),
              release: () => connection.release(),
            } satisfies OnlineMigrationConnection;
            try {
              await work({
                query: async (query) => await client.unsafe<unknown[]>(query),
                run: async ({ confirmation, emit } = {}) =>
                  await runMigrations({
                    connection,
                    databaseUrl: scratchUrl.toString(),
                    migrationsFolder: folder,
                    migrationsSchema: ledgerSchema,
                    ebs: { type: "disabled" },
                    runOnline: async () => ({ type: "complete" }),
                    manualDrainConfirmation: confirmation,
                    cutoverEmit: emit,
                  }),
                seedScheduler: async () => {
                  // Use the committed scheduler DDL, without mirroring its columns.
                  const statements = readFileSync(
                    path.join(
                      corpusFolder,
                      "20260430131000_agenda_scheduler_infosoud/migration.sql",
                    ),
                    "utf-8",
                  ).split("--> statement-breakpoint");
                  for (const statement of statements.slice(0, 2)) {
                    await client.unsafe(statement);
                  }
                  await client.unsafe(`INSERT INTO scheduler_jobs
                    (id, task, schedule, next_run_at)
                    VALUES ('cutover-fixture', 'cutover.fixture',
                      '{"type":"interval","everyMs":60000}'::jsonb, clock_timestamp())`);
                },
                seedRecentAdmission: async () => {
                  await ensureTableLeaseQueue({ connection: adapter });
                  const holderId = `recent-claim:${Bun.randomUUIDv7()}`;
                  expect(
                    await db.transaction(
                      async (tx) =>
                        await acquireJobTableLeases({
                          tx,
                          tables: [getTableName(schedulerTableLeases)],
                          holderId,
                          leaseMs: DEFAULT_LEASE_MS,
                        }),
                    ),
                  ).toBe(true);
                  await releaseJobTableLeases(db, holderId);
                  expect(
                    await client.unsafe(
                      "SELECT holder_id FROM scheduler_table_leases WHERE holder_id = $1",
                      [holderId],
                    ),
                  ).toHaveLength(0);
                },
              });
            } finally {
              await connection.release();
            }
          },
        );
      } finally {
        await admin.unsafe(`DROP DATABASE "${databaseName}"`);
      }
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};

describe.skipIf(!enabled)(
  "migration cutover admission against real PostgreSQL",
  () => {
    test("a fresh database proceeds without an attestation", async () => {
      await withCutoverFixture(TABLE_LEASE_MIGRATION, async ({ run }) => {
        expect(await run()).toMatchObject({
          status: "applied",
          insertedNames: [TABLE_LEASE_MIGRATION],
        });
      });
    });

    test.each([
      "last_run_at = clock_timestamp()",
      "locked_by = 'older-worker', locked_until = clock_timestamp() + interval '1 minute'",
    ])("active older workers refuse before DDL: %s", async (activity) => {
      await withCutoverFixture(
        TABLE_LEASE_MIGRATION,
        async ({ run, query, seedScheduler }) => {
          await seedScheduler();
          await query(`UPDATE scheduler_jobs SET ${activity}`);
          expect(await rejectionOf(run())).toBeInstanceOf(
            MigrationSchedulerDrainRequired,
          );
          expect(
            await query(
              `SELECT nspname FROM pg_namespace WHERE nspname = '${ledgerSchema}'`,
            ),
          ).toHaveLength(0);
          expect(
            await query(
              "SELECT relname FROM pg_class WHERE relname IN ('scheduler_table_leases', 'scheduler_table_lease_activity')",
            ),
          ).toHaveLength(0);
        },
      );
    });

    test.each([
      "last_run_at = clock_timestamp() - interval '11 minutes'",
      "locked_by = 'expired-worker', locked_until = clock_timestamp() - interval '1 minute'",
      "locked_until = clock_timestamp() + interval '1 minute'",
    ])(
      "inactive scheduler evidence proceeds without an attestation: %s",
      async (activity) => {
        await withCutoverFixture(
          TABLE_LEASE_MIGRATION,
          async ({ run, query, seedScheduler }) => {
            await seedScheduler();
            await query(`UPDATE scheduler_jobs SET ${activity}`);
            expect(await run()).toMatchObject({
              status: "applied",
              insertedNames: [TABLE_LEASE_MIGRATION],
            });
          },
        );
      },
    );

    test("a recent lease-aware claim remains evidence after its leases are released", async () => {
      await withCutoverFixture(
        TABLE_LEASE_MIGRATION,
        async ({ run, seedRecentAdmission, seedScheduler, query }) => {
          await seedScheduler();
          await query(
            "UPDATE scheduler_jobs SET last_run_at = clock_timestamp()",
          );
          await seedRecentAdmission();
          expect(await run()).toMatchObject({
            status: "applied",
            insertedNames: [TABLE_LEASE_MIGRATION],
          });
        },
      );
    });

    test("an expired admission watermark refuses the pending locking set", async () => {
      await withCutoverFixture(
        TABLE_LEASE_MIGRATION,
        async ({ run, seedRecentAdmission, seedScheduler, query }) => {
          await seedScheduler();
          await query(
            "UPDATE scheduler_jobs SET last_run_at = clock_timestamp()",
          );
          await seedRecentAdmission();
          await query(
            "UPDATE scheduler_table_lease_activity SET last_claimed_at = clock_timestamp() - interval '11 minutes'",
          );
          expect(await rejectionOf(run())).toBeInstanceOf(
            MigrationSchedulerDrainRequired,
          );
          expect(
            await query(
              `SELECT nspname FROM pg_namespace WHERE nspname = '${ledgerSchema}'`,
            ),
          ).toHaveLength(0);
        },
      );
    });

    test("typed manual confirmation admits only the readiness check and emits its reason", async () => {
      await withCutoverFixture(
        TABLE_LEASE_MIGRATION,
        async ({ run, seedScheduler, query }) => {
          await seedScheduler();
          await query(
            "UPDATE scheduler_jobs SET last_run_at = clock_timestamp()",
          );
          const events: MigrationCutoverEvent[] = [];
          expect(
            await run({
              confirmation: parseMigrationDrainConfirmation(
                "Scheduler workers drained for isolated maintenance",
              ).unwrap(),
              emit: (event) => events.push(event),
            }),
          ).toMatchObject({
            status: "applied",
            insertedNames: [TABLE_LEASE_MIGRATION],
          });
          expect(events).toEqual([
            {
              event: "migrate.manual_drain_confirmed",
              reason: "Scheduler workers drained for isolated maintenance",
              tableCount: expect.any(Number),
            },
          ]);
        },
      );
    });

    test("a pending migration with no relation lock needs no recent activity", async () => {
      await withCutoverFixture(
        NO_LOCK_MIGRATION,
        async ({ run, query, seedScheduler }) => {
          await seedScheduler();
          await query(
            "UPDATE scheduler_jobs SET last_run_at = clock_timestamp()",
          );
          expect(await run()).toMatchObject({
            status: "applied",
            insertedNames: [NO_LOCK_MIGRATION],
          });
          expect(
            await query(
              "SELECT relname FROM pg_class WHERE relname = 'scheduler_table_lease_activity'",
            ),
          ).toHaveLength(0);
        },
      );
    });
  },
);
