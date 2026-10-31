import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
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
import { getPgErrorCode, PG_ERROR } from "../lib/pg-error";
import { withGatedTestClients } from "../tests/gated-test-database";
import { MigrationSchedulerDrainRequired } from "./migration-cutover";
import type { MigrationCutoverEvent } from "./migration-cutover";
import {
  MIGRATION_LOCK_MANIFEST_FILE,
  pendingMigrationLockTables,
} from "./migration-lock-manifest";
import { runMigrations } from "./migration-runner";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import { recordTableLeaseProtocol } from "./record-table-lease-protocol";
import { TABLE_LEASE_PROTOCOL } from "./table-lease-protocol";
import {
  ensureTableLeaseQueue,
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
    query: (
      query: string,
      params?: (string | number)[],
    ) => PromiseLike<unknown[]>;
    createStorage: () => Promise<void>;
    recordProtocol: () => Promise<void>;
    tableCount: number;
    createScheduler: () => Promise<void>;
    seedHistory: () => Promise<void>;
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
    const tableCount = pendingMigrationLockTables(manifest, [
      migrationName,
    ]).length;
    if (migrationName === TABLE_LEASE_MIGRATION) {
      expect(tableCount).toBeGreaterThan(0);
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
              release: async () => {
                await connection.release();
              },
            } satisfies OnlineMigrationConnection;
            try {
              await work({
                tableCount,
                query: async (query, params = []) =>
                  await client.unsafe<unknown[]>(query, params),
                createStorage: async () =>
                  await ensureTableLeaseQueue({ connection: adapter }),
                createScheduler: async () => {
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
                },
                seedHistory: async () => {
                  await client.unsafe(`INSERT INTO scheduler_jobs
                    (id, task, schedule, next_run_at)
                    VALUES ('cutover-fixture', 'cutover.fixture',
                      '{"type":"interval","everyMs":60000}'::jsonb, clock_timestamp())`);
                },
                recordProtocol: async () => {
                  await ensureTableLeaseQueue({ connection: adapter });
                  await db.transaction(async (tx) => {
                    await recordTableLeaseProtocol(tx);
                  });
                },
                run: async ({ confirmation, emit }: CutoverRunOptions = {}) =>
                  await runMigrations({
                    connection,
                    databaseUrl: scratchUrl.toString(),
                    migrationsFolder: folder,
                    migrationsSchema: ledgerSchema,
                    ebs: { type: "disabled" },
                    runOnline: async () => ({ type: "complete" }),
                    ...(confirmation === undefined
                      ? {}
                      : { manualDrainConfirmation: confirmation }),
                    ...(emit === undefined ? {} : { cutoverEmit: emit }),
                  }),
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
  "migration protocol admission against real PostgreSQL",
  () => {
    test.each([TABLE_LEASE_MIGRATION, NO_LOCK_MIGRATION])(
      "a fresh database bootstraps the protocol before %s",
      async (migrationName) => {
        await withCutoverFixture(
          migrationName,
          async ({ run, query, tableCount }) => {
            const events: MigrationCutoverEvent[] = [];
            expect(
              await run({
                emit: (event) => {
                  events.push(event);
                },
              }),
            ).toMatchObject({
              status: "applied",
              insertedNames: [migrationName],
            });
            expect(events).toEqual([
              {
                event: "migrate.table_lease_protocol_bootstrapped",
                protocol: TABLE_LEASE_PROTOCOL,
                tableCount,
              },
            ]);
            expect(
              await query(
                "SELECT protocol FROM scheduler_table_lease_protocol WHERE protocol = $1",
                [TABLE_LEASE_PROTOCOL],
              ),
            ).toHaveLength(1);
          },
        );
      },
    );

    test("an empty scheduler table bootstraps without a confirmation", async () => {
      await withCutoverFixture(
        TABLE_LEASE_MIGRATION,
        async ({ run, query, createScheduler, tableCount }) => {
          await createScheduler();
          const events: MigrationCutoverEvent[] = [];
          expect(
            await run({
              emit: (event) => {
                events.push(event);
              },
            }),
          ).toMatchObject({
            status: "applied",
            insertedNames: [TABLE_LEASE_MIGRATION],
          });
          expect(events).toEqual([
            {
              event: "migrate.table_lease_protocol_bootstrapped",
              protocol: TABLE_LEASE_PROTOCOL,
              tableCount,
            },
          ]);
          expect(
            await query(
              "SELECT protocol FROM scheduler_table_lease_protocol WHERE protocol = $1",
              [TABLE_LEASE_PROTOCOL],
            ),
          ).toHaveLength(1);
        },
      );
    });

    test.each([TABLE_LEASE_MIGRATION, NO_LOCK_MIGRATION])(
      "scheduler history without protocol storage refuses before DDL for %s",
      async (migrationName) => {
        await withCutoverFixture(
          migrationName,
          async ({ run, query, createScheduler, seedHistory }) => {
            await createScheduler();
            await seedHistory();
            const error = await rejectionOf(run());
            expect(error).toBeInstanceOf(MigrationSchedulerDrainRequired);
            expect(error).toMatchObject({
              message: expect.stringMatching(/manual.*drain/iu),
            });
            expect(
              await query(
                `SELECT nspname FROM pg_namespace WHERE nspname = '${ledgerSchema}'`,
              ),
            ).toHaveLength(0);
            expect(
              await query(
                "SELECT relname FROM pg_class WHERE relname IN ('scheduler_table_leases', 'scheduler_table_lease_protocol')",
              ),
            ).toHaveLength(0);
          },
        );
      },
    );

    test("scheduler history and empty protocol storage still requires a manual drain", async () => {
      await withCutoverFixture(
        TABLE_LEASE_MIGRATION,
        async ({ run, query, createStorage, createScheduler, seedHistory }) => {
          await createScheduler();
          await seedHistory();
          await createStorage();
          expect(
            await query("SELECT protocol FROM scheduler_table_lease_protocol"),
          ).toHaveLength(0);
          const error = await rejectionOf(run());
          expect(error).toBeInstanceOf(MigrationSchedulerDrainRequired);
          expect(error).toMatchObject({
            message: expect.stringMatching(/manual.*drain/iu),
          });
          expect(
            await query(
              `SELECT nspname FROM pg_namespace WHERE nspname = '${ledgerSchema}'`,
            ),
          ).toHaveLength(0);
        },
      );
    });

    test.each([TABLE_LEASE_MIGRATION, NO_LOCK_MIGRATION])(
      "the protocol marker admits %s with scheduler history and no confirmation",
      async (migrationName) => {
        await withCutoverFixture(
          migrationName,
          async ({ run, recordProtocol, createScheduler, seedHistory }) => {
            await createScheduler();
            await seedHistory();
            await recordProtocol();
            const events: MigrationCutoverEvent[] = [];
            expect(
              await run({
                emit: (event) => {
                  events.push(event);
                },
              }),
            ).toMatchObject({
              status: "applied",
              insertedNames: [migrationName],
            });
            expect(events).toEqual([]);
          },
        );
      },
    );

    test("schema receipts restore root-only ACLs after a blanket application grant", async () => {
      await withCutoverFixture(
        TABLE_LEASE_MIGRATION,
        async ({ createStorage, query, run }) => {
          await createStorage();
          await query(
            "GRANT SELECT, INSERT, UPDATE ON TABLE scheduler_table_leases, scheduler_table_lease_protocol TO stella",
          );
          expect(await run()).toMatchObject({
            status: "applied",
            insertedNames: [TABLE_LEASE_MIGRATION],
          });
          const privileges = await query(`SELECT
          has_table_privilege('stella', 'public.scheduler_table_leases', 'SELECT') AS queue,
          has_table_privilege('stella', 'public.scheduler_table_lease_protocol', 'SELECT') AS protocol`);
          expect([...privileges]).toEqual([{ queue: false, protocol: false }]);
        },
      );
    });

    test("recording the protocol repeatedly preserves first activation", async () => {
      await withCutoverFixture(
        TABLE_LEASE_MIGRATION,
        async ({ query, recordProtocol }) => {
          await recordProtocol();
          const first = await query(
            "SELECT protocol, first_seen_at::text AS first_seen_at FROM scheduler_table_lease_protocol WHERE protocol = $1",
            [TABLE_LEASE_PROTOCOL],
          );
          expect(first).toHaveLength(1);
          await recordProtocol();
          expect(
            await query(
              "SELECT protocol, first_seen_at::text AS first_seen_at FROM scheduler_table_lease_protocol WHERE protocol = $1",
              [TABLE_LEASE_PROTOCOL],
            ),
          ).toEqual(first);
          expect(
            await query("SELECT protocol FROM scheduler_table_lease_protocol"),
          ).toHaveLength(1);
        },
      );
    });

    test("the committed protocol constraint rejects another protocol", async () => {
      await withCutoverFixture(
        TABLE_LEASE_MIGRATION,
        async ({ query, createStorage }) => {
          await createStorage();
          const error = await rejectionOf(
            query(
              "INSERT INTO scheduler_table_lease_protocol (protocol) VALUES ($1)",
              ["unknown-table-lease-protocol"],
            ),
          );
          expect(getPgErrorCode(error)).toBe(PG_ERROR.CHECK_VIOLATION);
          expect(
            await query("SELECT protocol FROM scheduler_table_lease_protocol"),
          ).toHaveLength(0);
        },
      );
    });

    test.each([TABLE_LEASE_MIGRATION, NO_LOCK_MIGRATION])(
      "typed manual confirmation admits %s and emits its reason",
      async (migrationName) => {
        await withCutoverFixture(
          migrationName,
          async ({ run, tableCount, createScheduler, seedHistory }) => {
            await createScheduler();
            await seedHistory();
            const events: MigrationCutoverEvent[] = [];
            expect(
              await run({
                confirmation: parseMigrationDrainConfirmation(
                  "Scheduler workers drained for isolated maintenance",
                ).unwrap(),
                emit: (event) => {
                  events.push(event);
                },
              }),
            ).toMatchObject({
              status: "applied",
              insertedNames: [migrationName],
            });
            expect(events).toEqual([
              {
                event: "migrate.manual_drain_confirmed",
                reason: "Scheduler workers drained for isolated maintenance",
                tableCount,
              },
            ]);
          },
        );
      },
    );
  },
);
