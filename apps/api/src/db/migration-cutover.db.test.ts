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
import { createSafeId } from "../lib/branded-types";
import type { SafeId } from "../lib/branded-types";
import { DEFAULT_LEASE_MS } from "../lib/scheduler/lease-timing";
import { withGatedTestClients } from "../tests/gated-test-database";
import {
  assertMigrationCutover,
  MigrationSchedulerDrainRequired,
} from "./migration-cutover";
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

type CoveredExecutionOptions = {
  jobId?: string;
  minutesAgo?: number;
};

type CoveredExecution = {
  token: string;
  holderId: string;
  runId: SafeId<"schedulerJobRun">;
};

const withCutoverFixture = async (
  migrationName: string,
  work: (fixture: {
    run: (options?: CutoverRunOptions) => ReturnType<typeof runMigrations>;
    query: (
      query: string,
      params?: (string | number)[],
    ) => PromiseLike<unknown[]>;
    admit: () => Promise<void>;
    seedCoveredExecution: (
      options?: CoveredExecutionOptions,
    ) => Promise<CoveredExecution>;
    releaseExecution: (holderId: string) => Promise<void>;
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
                query: async (query, params = []) =>
                  await client.unsafe<unknown[]>(query, params),
                admit: async () =>
                  await assertMigrationCutover({
                    connection: adapter,
                    tables: pendingMigrationLockTables(manifest, [
                      migrationName,
                    ]),
                    confirmation: { type: "automatic" },
                  }),
                releaseExecution: async (holderId) =>
                  await releaseJobTableLeases(db, holderId),
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
                  for (const statement of statements.slice(0, 4)) {
                    await client.unsafe(statement);
                  }
                  await client.unsafe(`INSERT INTO scheduler_jobs
                    (id, task, schedule, next_run_at)
                    VALUES ('cutover-fixture', 'cutover.fixture',
                      '{"type":"interval","everyMs":60000}'::jsonb, clock_timestamp())`);
                },
                seedCoveredExecution: async ({
                  jobId = "cutover-fixture",
                  minutesAgo = 0,
                } = {}) => {
                  await ensureTableLeaseQueue({ connection: adapter });
                  const runId = createSafeId<"schedulerJobRun">();
                  const token = `covered:${runId}`;
                  const holderId = `${jobId}:${token}`;
                  await client.unsafe(
                    `INSERT INTO scheduler_jobs
                    (id, task, schedule, next_run_at)
                    VALUES ($1, 'cutover.fixture', '{"type":"interval","everyMs":60000}'::jsonb,
                      clock_timestamp()) ON CONFLICT (id) DO NOTHING`,
                    [jobId],
                  );
                  expect(
                    await db.transaction(
                      async (tx) =>
                        await acquireJobTableLeases({
                          tx,
                          tables: [getTableName(schedulerTableLeases)],
                          holderId,
                          leaseMs: DEFAULT_LEASE_MS,
                          execution: { token, jobId, runId },
                        }),
                    ),
                  ).toBe(true);
                  await client.unsafe(
                    `UPDATE scheduler_jobs
                    SET locked_by = $1, locked_until = clock_timestamp() + interval '1 minute'
                    WHERE id = $2`,
                    [token, jobId],
                  );
                  await client.unsafe(
                    `INSERT INTO scheduler_job_runs
                    (id, job_id, task, runner_id, status, started_at)
                    VALUES ($1, $2, 'cutover.fixture', 'lease-aware-fixture', 'running',
                      clock_timestamp() - $3::integer * interval '1 minute')`,
                    [runId, jobId, minutesAgo],
                  );
                  await client.unsafe(
                    `UPDATE scheduler_table_lease_activity
                    SET claimed_at = clock_timestamp() - $1::integer * interval '1 minute'
                    WHERE execution_token = $2`,
                    [minutesAgo, token],
                  );
                  return { token, holderId, runId };
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

    test.each(["covered-other", "cutover-fixture"])(
      "an older active execution refuses despite a recent claim for %s",
      async (coveredJobId) => {
        await withCutoverFixture(
          TABLE_LEASE_MIGRATION,
          async ({ run, query, seedScheduler, seedCoveredExecution }) => {
            await seedScheduler();
            await seedCoveredExecution({ jobId: coveredJobId });
            await query(
              "UPDATE scheduler_jobs SET locked_by = 'older-worker', locked_until = clock_timestamp() + interval '1 minute' WHERE id = 'cutover-fixture'",
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
      },
    );

    test("an active uncovered execution refuses before coordination DDL", async () => {
      await withCutoverFixture(
        TABLE_LEASE_MIGRATION,
        async ({ run, query, seedScheduler }) => {
          await seedScheduler();
          await query(
            "UPDATE scheduler_jobs SET locked_by = 'older-worker', locked_until = clock_timestamp() + interval '1 minute'",
          );
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

    test("one long-running covered execution admits with live table leases and no newer claims", async () => {
      await withCutoverFixture(
        TABLE_LEASE_MIGRATION,
        async ({
          admit,
          run,
          query,
          seedScheduler,
          seedCoveredExecution,
          releaseExecution,
        }) => {
          await seedScheduler();
          const { holderId } = await seedCoveredExecution({ minutesAgo: 30 });
          expect(
            await query(
              "SELECT execution_token FROM scheduler_table_lease_activity",
            ),
          ).toHaveLength(1);
          expect(
            await query(
              "SELECT execution_token FROM scheduler_table_lease_activity WHERE claimed_at < clock_timestamp() - interval '10 minutes' AND expires_at > clock_timestamp()",
            ),
          ).toHaveLength(1);
          expect(
            await query(
              "SELECT holder_id FROM scheduler_table_leases WHERE holder_id = $1 AND expires_at > clock_timestamp()",
              [holderId],
            ),
          ).toHaveLength(1);
          await admit();
          await releaseExecution(holderId);
          expect(await run()).toMatchObject({
            status: "applied",
            insertedNames: [TABLE_LEASE_MIGRATION],
          });
        },
      );
    });

    test.each([false, true])(
      "an uncovered old run finished five minutes ago refuses (new covered execution: %s)",
      async (covered) => {
        await withCutoverFixture(
          TABLE_LEASE_MIGRATION,
          async ({ run, query, seedScheduler, seedCoveredExecution }) => {
            await seedScheduler();
            await query(
              `INSERT INTO scheduler_job_runs
          (id, job_id, task, runner_id, status, started_at, finished_at)
          VALUES ($1, 'cutover-fixture', 'cutover.fixture', 'older-worker', 'success',
            clock_timestamp() - interval '30 minutes', clock_timestamp() - interval '5 minutes')`,
              [Bun.randomUUIDv7()],
            );
            if (covered) {
              await seedCoveredExecution();
            }
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
      },
    );

    test("an expired execution record refuses even when its token matches", async () => {
      await withCutoverFixture(
        TABLE_LEASE_MIGRATION,
        async ({ run, query, seedScheduler, seedCoveredExecution }) => {
          await seedScheduler();
          const { token } = await seedCoveredExecution();
          await query(
            "UPDATE scheduler_table_lease_activity SET expires_at = clock_timestamp() - interval '1 minute' WHERE execution_token = $1",
            [token],
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

    test("completed covered execution retains its exact evidence after table leases release", async () => {
      await withCutoverFixture(
        TABLE_LEASE_MIGRATION,
        async ({
          run,
          query,
          seedScheduler,
          seedCoveredExecution,
          releaseExecution,
        }) => {
          await seedScheduler();
          const { holderId, runId, token } = await seedCoveredExecution({
            minutesAgo: 30,
          });
          await query(
            "UPDATE scheduler_jobs SET locked_by = NULL, locked_until = NULL",
          );
          await query(
            "UPDATE scheduler_job_runs SET status = 'success', finished_at = clock_timestamp() - interval '5 minutes' WHERE id = $1",
            [runId],
          );
          await releaseExecution(holderId);
          expect(
            await query(
              "SELECT holder_id FROM scheduler_table_leases WHERE holder_id = $1",
              [holderId],
            ),
          ).toHaveLength(0);
          expect(
            await query(
              "SELECT run_id FROM scheduler_table_lease_activity WHERE execution_token = $1 AND run_id = $2",
              [token, runId],
            ),
          ).toHaveLength(1);
          expect(await run()).toMatchObject({
            status: "applied",
            insertedNames: [TABLE_LEASE_MIGRATION],
          });
        },
      );
    });

    test("idle storage with only abandoned older run rows proceeds", async () => {
      await withCutoverFixture(
        TABLE_LEASE_MIGRATION,
        async ({ run, query, seedScheduler }) => {
          await seedScheduler();
          await query(
            `INSERT INTO scheduler_job_runs
          (id, job_id, task, runner_id, status, started_at)
          VALUES ($1, 'cutover-fixture', 'cutover.fixture', 'older-worker', 'running',
            clock_timestamp() - interval '30 minutes')`,
            [Bun.randomUUIDv7()],
          );
          expect(await run()).toMatchObject({
            status: "applied",
            insertedNames: [TABLE_LEASE_MIGRATION],
          });
        },
      );
    });

    test("typed manual confirmation admits only the readiness check and emits its reason", async () => {
      await withCutoverFixture(
        TABLE_LEASE_MIGRATION,
        async ({ run, seedScheduler, query }) => {
          await seedScheduler();
          await query(
            "UPDATE scheduler_jobs SET locked_by = 'older-worker', locked_until = clock_timestamp() + interval '1 minute'",
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

    test("an empty lock union admits despite an active uncovered execution", async () => {
      await withCutoverFixture(
        NO_LOCK_MIGRATION,
        async ({ run, query, seedScheduler }) => {
          await seedScheduler();
          await query(
            "UPDATE scheduler_jobs SET locked_by = 'older-worker', locked_until = clock_timestamp() + interval '1 minute'",
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
