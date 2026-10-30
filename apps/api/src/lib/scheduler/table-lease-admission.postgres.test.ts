import { describe, expect, test } from "bun:test";
import { eq, getTableName } from "drizzle-orm";

import { deferred } from "@stll/test-kit";

import type { OnlineMigrationConnection } from "@/api/db/online-migration-connection";
import {
  caseLawDecisions,
  legislationWorks,
  schedulerJobRuns,
  schedulerJobs,
} from "@/api/db/schema";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { acquireMigrationTableLeases } from "../../db/table-lease-queue";
import { DECLARED_SCHEDULER_JOBS, tablesForSchedulerTask } from "./jobs";
import { DEFAULT_LEASE_MS } from "./lease-timing";
import { REGISTERED_SCHEDULER_TASK_NAMES } from "./registry";
import { acquireNextDueJob, runSchedulerOnce } from "./runner";
import type { SchedulerTask } from "./types";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const requestedTable = getTableName(caseLawDecisions);
const unrelatedTable = getTableName(legislationWorks);

describe.skipIf(!enabled)("scheduler table lease admission (postgres)", () => {
  test("every scheduler declaration names a migrated public table", async () => {
    if (!databaseUrl) {
      throw new TypeError("DATABASE_URL is required");
    }
    const declared = [
      ...new Set([
        ...DECLARED_SCHEDULER_JOBS.flatMap(({ tables }) => [
          ...tables.reads,
          ...tables.writes,
        ]),
        ...REGISTERED_SCHEDULER_TASK_NAMES.flatMap((task) =>
          tablesForSchedulerTask(task),
        ),
      ]),
    ];
    expect(declared.length).toBeGreaterThan(0);
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const tables = await openClient().sql.unsafe<{ name: string }[]>(
        "SELECT relation.relname AS name FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p')",
      );
      const existing = new Set(tables.map(({ name }) => name));
      expect(declared.filter((name) => !existing.has(name))).toEqual([]);
    });
  });

  test("a queued migration drains its older execution while unrelated due work runs", async () => {
    if (!databaseUrl) {
      throw new TypeError("DATABASE_URL is required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db, sql: client } = openClient({ max: 4 });
      const migration = await openClient().sql.reserve();
      const prefix = `table-lease.${Bun.randomUUIDv7()}`;
      const task = `${prefix}.conflicting`;
      const unrelatedTask = `${prefix}.unrelated`;
      const firstId = `${prefix}.first`;
      const laterId = `${prefix}.later`;
      const unrelatedId = `${prefix}.other`;
      const started = deferred();
      const finish = deferred();
      const requested = deferred();
      const firstTask: SchedulerTask = async () => {
        started.resolve();
        await finish.promise;
      };
      const tablesForTask = (name: string) =>
        name === unrelatedTask ? [unrelatedTable] : [requestedTable];
      const adapter: OnlineMigrationConnection = {
        query: async (query, params = []) =>
          await migration.unsafe<unknown[]>(query, [...params]),
        execute: async (query, params = []) => {
          await migration.unsafe(query, [...params]);
        },
        release: () => migration.release(),
      };
      let running: ReturnType<typeof runSchedulerOnce> | undefined;
      let waiting: ReturnType<typeof acquireMigrationTableLeases> | undefined;
      let leases:
        Awaited<ReturnType<typeof acquireMigrationTableLeases>> | undefined;
      try {
        await db.insert(schedulerJobs).values({
          id: firstId,
          description: "table lease execution",
          task,
          schedule: { type: "interval", everyMs: DEFAULT_LEASE_MS },
          nextRunAt: new Date("2020-01-01T00:00:00Z"),
        });
        running = runSchedulerOnce({
          db,
          registry: new Map([[task, firstTask]]),
          tablesForTask,
          rerunLimit: 0,
        });
        await started.promise;
        waiting = acquireMigrationTableLeases({
          connection: adapter,
          tables: [requestedTable],
          holderId: prefix,
          checkEveryMs: 10,
          waitMs: 2000,
          onLeaseLost: async (cause) => {
            throw cause;
          },
          emit: ({ event }) => {
            if (event === "migrate.table_lease_requested") {
              requested.resolve();
            }
          },
        });
        await requested.promise;
        await db.insert(schedulerJobs).values([
          {
            id: laterId,
            description: "conflicting due job",
            task,
            schedule: { type: "interval", everyMs: DEFAULT_LEASE_MS },
            nextRunAt: new Date("2020-01-01T00:00:00Z"),
          },
          {
            id: unrelatedId,
            description: "unrelated due job",
            task: unrelatedTask,
            schedule: { type: "interval", everyMs: DEFAULT_LEASE_MS },
            nextRunAt: new Date("2020-01-02T00:00:00Z"),
          },
        ]);
        const ran: string[] = [];
        const registry = new Map<string, SchedulerTask>([
          [
            task,
            ({ job }) => {
              ran.push(job.id);
            },
          ],
          [
            unrelatedTask,
            ({ job }) => {
              ran.push(job.id);
            },
          ],
        ]);
        const other = await runSchedulerOnce({
          db,
          registry,
          tablesForTask,
          rerunLimit: 0,
        });
        expect(other.succeeded).toBe(1);
        expect(ran).toEqual([unrelatedId]);
        const [due] = await db
          .select()
          .from(schedulerJobs)
          .where(eq(schedulerJobs.id, laterId));
        expect(due?.lockedBy).toBeNull();
        expect(due?.nextRunAt).toEqual(new Date("2020-01-01T00:00:00Z"));
        expect(due?.lastError).toBeNull();
        finish.resolve();
        expect((await running).succeeded).toBe(1);
        leases = await waiting;
        await leases.assertHeld();
        expect(
          await acquireNextDueJob({
            db,
            registry,
            tablesForTask,
            leaseMs: DEFAULT_LEASE_MS,
            runnerId: prefix,
          }),
        ).toBeNull();
        await leases.release();
        leases = undefined;
        expect(
          (
            await runSchedulerOnce({
              db,
              registry,
              tablesForTask,
              rerunLimit: 0,
            })
          ).succeeded,
        ).toBe(1);
        expect(ran).toEqual([unrelatedId, laterId]);
        const remaining = await client.unsafe<unknown[]>(
          "SELECT * FROM scheduler_table_leases WHERE holder_id LIKE $1",
          [`%${prefix}%`],
        );
        expect(remaining).toHaveLength(0);
      } finally {
        finish.resolve();
        await running;
        if (waiting) {
          leases ??= await waiting;
        }
        await leases?.release();
        await migration.release();
        await db
          .delete(schedulerJobRuns)
          .where(eq(schedulerJobRuns.jobId, firstId));
        await db
          .delete(schedulerJobRuns)
          .where(eq(schedulerJobRuns.jobId, laterId));
        await db
          .delete(schedulerJobRuns)
          .where(eq(schedulerJobRuns.jobId, unrelatedId));
        await db.delete(schedulerJobs).where(eq(schedulerJobs.id, firstId));
        await db.delete(schedulerJobs).where(eq(schedulerJobs.id, laterId));
        await db.delete(schedulerJobs).where(eq(schedulerJobs.id, unrelatedId));
      }
    });
  });
});
