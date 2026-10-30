import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, getTableName } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";
import { deferred } from "@stll/test-kit";

import type { OnlineMigrationConnection } from "@/api/db/online-migration-connection";
import {
  legislationWorks,
  schedulerJobRuns,
  schedulerJobs,
} from "@/api/db/schema";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import {
  acquireMigrationTableLeases,
  MigrationTableLeaseTimeoutError,
} from "../../db/table-lease-queue";
import { DEFAULT_LEASE_MS } from "./lease-timing";
import { runSchedulerOnce } from "./runner";
import type { SchedulerTask } from "./types";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const tableName = getTableName(legislationWorks);

describe.skipIf(!enabled)(
  "scheduler task table lease settlement (postgres)",
  () => {
    test("an abort-ignoring task retains and renews table leases until its transaction settles", async () => {
      if (!databaseUrl) {
        panic("DATABASE_URL is required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db, sql: client } = openClient({ max: 4 });
        const transaction = await openClient().sql.reserve();
        const migration = await openClient().sql.reserve();
        const id = `task-settlement.${Bun.randomUUIDv7()}`;
        const started = deferred();
        const releaseTask = deferred();
        const taskSettled = deferred();
        const renewedAfterCeiling = deferred();
        let observingRenewal = false;
        const observedDb = new Proxy(db, {
          get(target, property) {
            if (property === "execute") {
              return async (...parameters: Parameters<typeof db.execute>) => {
                const observeCompletion = observingRenewal;
                const result = await target.execute(...parameters);
                if (observeCompletion) {
                  renewedAfterCeiling.resolve();
                }
                return result;
              };
            }
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const task: SchedulerTask = async () => {
          await transaction.unsafe("BEGIN");
          try {
            await transaction.unsafe(`SELECT 1 FROM "${tableName}" LIMIT 1`);
            started.resolve();
            await releaseTask.promise;
          } finally {
            await transaction.unsafe("COMMIT");
            taskSettled.resolve();
          }
        };
        const adapter: OnlineMigrationConnection = {
          query: async (query, parameters = []) =>
            await migration.unsafe<unknown[]>(query, [...parameters]),
          execute: async (query, parameters = []) => {
            await migration.unsafe(query, [...parameters]);
          },
          release: () => migration.release(),
        };
        let running: ReturnType<typeof runSchedulerOnce> | undefined;
        let held:
          Awaited<ReturnType<typeof acquireMigrationTableLeases>> | undefined;
        try {
          await db.insert(schedulerJobs).values({
            id,
            description: "task table lease settlement",
            task: id,
            nextRunAt: new Date("2020-01-01T00:00:00Z"),
            schedule: { type: "interval", everyMs: DEFAULT_LEASE_MS },
          });
          running = runSchedulerOnce({
            db: observedDb,
            registry: new Map([[id, task]]),
            tablesForTask: () => [tableName],
            rerunLimit: 0,
            maxRuntimeMs: 25,
            heartbeatIntervalMs: 10,
          });
          await started.promise;
          expect((await running).failed).toBe(1);
          const [completed] = await db
            .select()
            .from(schedulerJobs)
            .where(eq(schedulerJobs.id, id));
          expect(completed?.lockedBy).toBeNull();
          expect(completed?.lastError).toBe("SchedulerJobTimeoutError");
          const before = await client.unsafe<{ expires_at: Date }[]>(
            "SELECT expires_at FROM scheduler_table_leases WHERE holder_kind = 'job' AND holder_id LIKE $1 AND table_name = $2",
            [`${id}:%`, tableName],
          );
          expect(before).toHaveLength(1);
          observingRenewal = true;
          await renewedAfterCeiling.promise;
          const after = await client.unsafe<{ expires_at: Date }[]>(
            "SELECT expires_at FROM scheduler_table_leases WHERE holder_kind = 'job' AND holder_id LIKE $1 AND table_name = $2",
            [`${id}:%`, tableName],
          );
          expect(after).toHaveLength(1);
          expect(after.at(0)?.expires_at.getTime()).toBeGreaterThan(
            before.at(0)?.expires_at.getTime() ?? panic("Missing lease expiry"),
          );
          const error = await rejectionOf(
            acquireMigrationTableLeases({
              connection: adapter,
              tables: [tableName],
              holderId: `${id}.refused`,
              waitMs: 0,
              onLeaseLost: async (cause) => {
                throw cause;
              },
            }),
          );
          expect(error).toBeInstanceOf(MigrationTableLeaseTimeoutError);
          expect(error).toMatchObject({ message: expect.stringContaining(id) });
          releaseTask.resolve();
          await taskSettled.promise;
          held = await acquireMigrationTableLeases({
            connection: adapter,
            tables: [tableName],
            holderId: `${id}.granted`,
            waitMs: 2000,
            checkEveryMs: 10,
            onLeaseLost: async (cause) => {
              throw cause;
            },
          });
          await held.assertHeld();
          expect(
            await client.unsafe(
              "SELECT holder_id FROM scheduler_table_leases WHERE holder_kind = 'job' AND holder_id LIKE $1",
              [`${id}:%`],
            ),
          ).toHaveLength(0);
        } finally {
          releaseTask.resolve();
          if (running) {
            await running;
            await taskSettled.promise;
          }
          await held?.release();
          await transaction.release();
          await migration.release();
          await db
            .delete(schedulerJobRuns)
            .where(eq(schedulerJobRuns.jobId, id));
          await db.delete(schedulerJobs).where(eq(schedulerJobs.id, id));
        }
      });
    });
  },
);
