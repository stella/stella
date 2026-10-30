import { panic, Result } from "better-result";
import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { schedulerJobRuns, schedulerJobs } from "@/api/db/schema";
import { computeCaseLawCoverageAnswer } from "@/api/handlers/case-law/decisions/coverage";
import { reapOwnerlessChatTurnOnTx } from "@/api/handlers/chat/chat-turn-persistence";
import { createSafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { SCHEDULER_DECLARATION_HARNESS } from "./declaration-harness";
import { DueSlot } from "./due-slot";
import { DECLARED_SCHEDULER_JOBS } from "./jobs";
import { createSchedulerTaskRegistry } from "./registry";
import { SCHEDULER_INFRASTRUCTURE_TABLES } from "./runner";
import { createCaseLawCoverageRefreshTask } from "./tasks/case-law-coverage-refresh";
import { createReapOwnerlessChatTurnsTask } from "./tasks/chat-turn-reaper";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const fixtureNow = new Date("2026-01-10T12:00:00Z");
const registry = createSchedulerTaskRegistry(
  createReapOwnerlessChatTurnsTask(reapOwnerlessChatTurnOnTx),
  createCaseLawCoverageRefreshTask({ compute: computeCaseLawCoverageAnswer }),
);

type TableCounters = {
  name: string;
  reads: number;
  writes: number;
};

/** One idle-boundary flush publishes this backend's committed task counters without waiting. */
const readTableCounters = async (client: SQL) => {
  await client.unsafe("SELECT pg_stat_force_next_flush()");
  await client.unsafe("SELECT pg_stat_clear_snapshot()");
  return await client.unsafe<TableCounters[]>(`
    SELECT parent.relname AS name,
      sum(stats.seq_scan + coalesce(stats.idx_scan, 0))::float8 AS reads,
      sum(stats.n_tup_ins + stats.n_tup_upd + stats.n_tup_del)::float8 AS writes
    FROM pg_stat_user_tables stats
    JOIN pg_class relation ON relation.oid = stats.relid
    JOIN pg_class parent ON parent.oid = CASE WHEN relation.relispartition
      THEN pg_partition_root(relation.oid) ELSE relation.oid END
    JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
    WHERE namespace.nspname = 'public'
    GROUP BY parent.oid, parent.relname ORDER BY parent.relname
  `);
};

const touchedRelations = (
  before: readonly TableCounters[],
  after: readonly TableCounters[],
) => {
  const previous = new Map(before.map((row) => [row.name, row]));
  return after
    .filter((row) => {
      const prior =
        previous.get(row.name) ?? panic(`Statistics lost relation ${row.name}`);
      return row.reads > prior.reads || row.writes > prior.writes;
    })
    .map(({ name }) => name);
};

const readBackend = async (client: SQL) => {
  const row =
    (
      await client.unsafe<
        { pid: number; supported: boolean; track_counts: string }[]
      >(
        "SELECT pg_backend_pid() AS pid, current_setting('server_version_num')::integer >= 150000 AS supported, current_setting('track_counts') AS track_counts",
      )
    ).at(0) ?? panic("Missing PostgreSQL statistics capabilities");
  expect(row.supported).toBe(true);
  expect(row.track_counts).toBe("on");
  return row.pid;
};

describe.skipIf(!enabled)(
  "scheduler table declarations match PostgreSQL observations",
  () => {
    for (const declared of DECLARED_SCHEDULER_JOBS) {
      const disposition = SCHEDULER_DECLARATION_HARNESS[declared.task];
      switch (disposition.status) {
        case "excluded":
          // Each excluded task needs its named external or backend fixture; re-enable when its disposition becomes run.
          test.skip(`${declared.id}: ${disposition.reason}`, () => undefined);
          break;
        case "run":
          test(`${declared.id} touches only reserved tables on the minimal migrated fixture`, async () => {
            if (!databaseUrl) {
              panic(
                "DATABASE_URL is required for scheduler declaration observation",
              );
            }
            await withGatedTestClients(databaseUrl, async ({ openClient }) => {
              // Each task and its flushes use exactly one backend. Dedicated/ambient-pool jobs
              // are excluded explicitly until they have fixture-owned connection injection.
              const { db, sql: client } = openClient({ max: 1 });
              const task =
                registry.get(declared.task) ??
                panic(`Missing registered task ${declared.task}`);
              const runId = createSafeId<"schedulerJobRun">();
              const [job] = await db
                .insert(schedulerJobs)
                .values({
                  id: declared.id,
                  task: declared.task,
                  description: declared.description,
                  schedule: declared.schedule,
                  payload: "payload" in declared ? declared.payload : null,
                  lockedBy: `declaration-harness:${runId}`,
                  lockedAt: fixtureNow,
                  nextRunAt: fixtureNow,
                })
                .returning();
              if (job === undefined) {
                panic("Missing declaration harness job");
              }
              await db.insert(schedulerJobRuns).values({
                id: runId,
                jobId: job.id,
                task: job.task,
                runnerId: "declaration-harness",
              });
              try {
                const backend = await readBackend(client);
                const before = await readTableCounters(client);
                const outcome = await task({
                  db,
                  dueAt: DueSlot.of(job),
                  job,
                  payload: job.payload,
                  runId,
                  scheduleContinuation: () => undefined,
                  signal: new AbortController().signal,
                  logger,
                });
                if (outcome !== undefined && Result.isError(outcome)) {
                  panic(
                    `Task ${declared.task} did not finish its fixture: ${outcome.error.message}`,
                  );
                }
                const after = await readTableCounters(client);
                expect(await readBackend(client)).toBe(backend);
                const touched = touchedRelations(before, after);
                expect(touched.length).toBeGreaterThan(0);
                const reserved = [
                  ...declared.tables.reads,
                  ...declared.tables.writes,
                  ...SCHEDULER_INFRASTRUCTURE_TABLES,
                ];
                expect(
                  touched.filter(
                    (name) => !reserved.some((table) => table === name),
                  ),
                ).toEqual([]);
              } finally {
                await db
                  .delete(schedulerJobRuns)
                  .where(eq(schedulerJobRuns.id, runId));
                await db
                  .delete(schedulerJobs)
                  .where(eq(schedulerJobs.id, job.id));
              }
            });
          });
          break;
        default:
          disposition satisfies never;
          panic("Unknown declaration harness disposition");
      }
    }
  },
);
