import { panic, Result } from "better-result";
import type { ReservedSQL } from "bun";
import { describe, expect, test } from "bun:test";

import { defaultConfig } from "@stll/db-load-gate/health";

import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { declaresOnlineBuild } from "../../../db/online-ddl";
import type { OnlineIndexGateOptions } from "../../../db/online-index-gate";
import type { OnlineBuildConnection } from "../../../db/online-migration-connection";
import {
  claimOnlineWorkUnit,
  ONLINE_MIGRATION_INDEXES,
  ONLINE_WORK_NAMES,
} from "../../../db/online-migrations";
import { PENDING } from "../../../db/online-work-lifecycle";
import { terminateReserved } from "../../../db/sql-close";
import { withGatedTestClients } from "../../../tests/gated-test-database";
import { allFinalizedOnlineWork } from "../../../tests/helpers/online-work-lifecycle";
import {
  createDrizzleOnlineWorkStateStore,
  createOnlineWorkRunner,
} from "./online-work-runner";

/**
 * The runner against a real database: a pending index that is missing is
 * built by the work a tick starts, its row ends finalized, and a tick while
 * another session holds the online lock claims nothing.
 */

const databaseUrl = process.env["DATABASE_URL"];
const TICK = new Date("2026-10-23T10:00:00.000Z");
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const pendingIndex = () => {
  type RegisteredIndex = (typeof ONLINE_MIGRATION_INDEXES)[number];
  const isBuildable = (
    index: RegisteredIndex,
  ): index is RegisteredIndex & { createSql: string } =>
    declaresOnlineBuild(index);
  return (
    ONLINE_MIGRATION_INDEXES.find(isBuildable) ??
    panic("Expected a buildable online index")
  );
};

const adapter = (session: ReservedSQL): OnlineBuildConnection => ({
  execute: async (query, params = []) => {
    await session.unsafe(query, [...params]);
  },
  query: async (query, params = []) => await session.unsafe(query, [...params]),
  release: () => undefined,
  terminate: async () => {
    await terminateReserved(session);
  },
});

const healthyGate = (): OnlineIndexGateOptions => ({
  config: {
    health: { ...defaultConfig, busyWindows: [], longTxMaxAgeMs: 3_600_000 },
    pollMs: 10,
    retryMs: 10,
    maxSnapshotWaitMs: 600_000,
    clientConnectionCheckMs: 10,
    // No holder in these tests is the wait under test.
    idleHolderMs: 3_600_000,
    longHolderMs: 3_600_000,
    parallelWorkers: 1,
    maintenanceWorkMemMb: 16,
  },
  ebs: {
    type: "reader",
    read: async () => ({
      indicator: "ebs_balance",
      kind: "normal",
      value: 100,
      threshold: 70,
      observedAt: new Date(Date.now()).toISOString(),
      reason: "injected healthy metric",
    }),
  },
  log: () => undefined,
});

describe.skipIf(!enabled)("online work runner on Postgres", () => {
  test("builds a missing pending index after rollout and records it finalized", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL is required");
    }
    const index = pendingIndex();
    await withGatedTestClients(
      databaseUrl,
      async ({ openClient }) => {
        const main = openClient({ max: 2 });
        const builder = await openClient().sql.reserve();
        const observer = await openClient().sql.reserve();
        const work: Promise<unknown>[] = [];
        try {
          await main.sql.unsafe(
            `DROP INDEX CONCURRENTLY IF EXISTS public."${index.name}"`,
          );
          const lifecycle = {
            ...allFinalizedOnlineWork(),
            [index.name]: PENDING,
          };
          const runner = createOnlineWorkRunner({
            names: ONLINE_WORK_NAMES,
            lifecycle,
            store: createDrizzleOnlineWorkStateStore(
              asTestRaw<SchedulerDb>(main.db),
            ),
            claim: async ({ name }) =>
              await claimOnlineWorkUnit(
                { reserve: async () => adapter(builder) },
                {
                  name,
                  lifecycle,
                  indexGate: healthyGate(),
                  reserveObserver: async () => adapter(observer),
                  timing: { clock: () => 0, emit: () => undefined },
                },
              ),
            detach: (unit) => {
              work.push(unit);
            },
          });

          expect((await runner(TICK)).unwrap()).toEqual({
            type: "started",
            name: index.name,
          });
          // The detached unit's own result first: a failed walk names its
          // cause here rather than as a missing index below.
          expect(await Promise.all(work)).toEqual([Result.ok(undefined)]);

          const built = await main.sql.unsafe<
            { valid: boolean; ready: boolean }[]
          >(
            `SELECT state.indisvalid AS valid, state.indisready AS ready
             FROM pg_index state
             JOIN pg_class relation ON relation.oid = state.indexrelid
             WHERE relation.relname = $1`,
            [index.name],
          );
          expect([...built]).toEqual([{ valid: true, ready: true }]);
          const row = await main.sql.unsafe<
            { state: string; attempts: number; last_error: string | null }[]
          >(
            "SELECT state, attempts, last_error FROM online_work_state WHERE name = $1",
            [index.name],
          );
          expect([...row]).toEqual([
            { state: "finalized", attempts: 1, last_error: null },
          ]);
          expect((await runner(TICK)).unwrap()).toEqual({ type: "idle" });
        } finally {
          await main.sql.unsafe("DELETE FROM online_work_state");
          const present = await main.sql.unsafe<{ present: boolean }[]>(
            "SELECT to_regclass($1) IS NOT NULL AS present",
            [`public."${index.name}"`],
          );
          if (present.at(0)?.present !== true) {
            await main.sql.unsafe(index.createSql);
          }
          await builder.release();
          await observer.release();
        }
      },
      { closeMode: "force" },
    );
  });

  test.each(["failed", "finalized"] as const)(
    "a stale %s checkpoint cannot change a newer attempt after its session terminates",
    async (checkpoint) => {
      if (databaseUrl === undefined) {
        panic("DATABASE_URL is required");
      }
      const index = pendingIndex();
      await withGatedTestClients(
        databaseUrl,
        async ({ openClient }) => {
          const main = openClient({ max: 2 });
          const firstSession = await openClient().sql.reserve();
          const secondSession = await openClient().sql.reserve();
          const firstConnection = adapter(firstSession);
          const secondConnection = adapter(secondSession);
          const lifecycle = {
            ...allFinalizedOnlineWork(),
            [index.name]: PENDING,
          };
          const claimOn = async (connection: OnlineBuildConnection) =>
            await claimOnlineWorkUnit(
              { reserve: async () => connection },
              {
                name: index.name,
                lifecycle,
                indexGate: healthyGate(),
                reserveObserver: async () => connection,
              },
            );
          const store = createDrizzleOnlineWorkStateStore(
            asTestRaw<SchedulerDb>(main.db),
          );
          const first = await claimOn(firstConnection);
          try {
            expect(first.type).toBe("claimed");
            const firstAttempt = await store.markBuilding({
              name: index.name,
              attempts: 1,
              at: TICK,
            });
            expect(firstAttempt).toBe(1);
            const backend = await firstSession.unsafe<{ pid: number }[]>(
              "SELECT pg_backend_pid() AS pid",
            );
            const pid =
              backend.at(0)?.pid ?? panic("Expected a builder backend");
            // Waiting for backend exit also waits for its advisory locks to go.
            const terminated = await main.sql.unsafe<{ terminated: boolean }[]>(
              "SELECT pg_terminate_backend($1, 5000) AS terminated",
              [pid],
            );
            expect(terminated.at(0)?.terminated).toBe(true);
            await firstConnection.terminate();

            const second = await claimOn(secondConnection);
            try {
              expect(second.type).toBe("claimed");
              const secondAttempt = await store.markBuilding({
                name: index.name,
                attempts: 2,
                at: new Date(TICK.getTime() + 1),
              });
              expect(secondAttempt).toBe(2);
              const readCheckpoint = async () =>
                await main.sql.unsafe(
                  "SELECT state, attempts, last_error, started_at, finished_at, updated_at FROM online_work_state WHERE name = $1",
                  [index.name],
                );
              const building = [...(await readCheckpoint())];
              expect(building).toMatchObject([
                {
                  state: "building",
                  attempts: 2,
                  last_error: null,
                  finished_at: null,
                },
              ]);
              const stale =
                checkpoint === "failed"
                  ? await store.markFailed({
                      name: index.name,
                      attempt: firstAttempt,
                      error: "the terminated attempt failed",
                    })
                  : await store.markFinalized({
                      name: index.name,
                      attempt: firstAttempt,
                    });
              expect([...(await readCheckpoint())]).toEqual(building);
              expect(stale).toEqual({
                type: "stale-attempt",
                name: index.name,
                attempt: 1,
              });
              expect(
                await store.markFinalized({
                  name: index.name,
                  attempt: secondAttempt,
                }),
              ).toEqual({ type: "updated" });
              expect([...(await readCheckpoint())]).toMatchObject([
                { state: "finalized", attempts: 2, last_error: null },
              ]);
            } finally {
              if (second.type === "claimed") {
                await second.release();
              }
            }
          } finally {
            if (first.type === "claimed") {
              await first.release();
            }
            await main.sql.unsafe(
              "DELETE FROM online_work_state WHERE name = $1",
              [index.name],
            );
            await secondSession.release();
          }
        },
        { closeMode: "force" },
      );
    },
  );

  test("a tick skips while another session holds the online lock", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL is required");
    }
    const index = pendingIndex();
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const main = openClient({ max: 2 });
      const holder = await openClient().sql.reserve();
      const claimer = await openClient().sql.reserve();
      const lifecycle = { ...allFinalizedOnlineWork(), [index.name]: PENDING };
      const claimOn = async (session: ReservedSQL) =>
        await claimOnlineWorkUnit(
          { reserve: async () => adapter(session) },
          {
            name: index.name,
            lifecycle,
            indexGate: healthyGate(),
            reserveObserver: async () => adapter(session),
          },
        );
      const held = await claimOn(holder);
      try {
        expect(held.type).toBe("claimed");
        const runner = createOnlineWorkRunner({
          names: ONLINE_WORK_NAMES,
          lifecycle,
          store: createDrizzleOnlineWorkStateStore(
            asTestRaw<SchedulerDb>(main.db),
          ),
          claim: async () => await claimOn(claimer),
          detach: () => panic("A skipped tick starts no work"),
        });

        expect((await runner(TICK)).unwrap()).toEqual({ type: "skipped" });
        const row = await main.sql.unsafe<
          { state: string; attempts: number }[]
        >("SELECT state, attempts FROM online_work_state WHERE name = $1", [
          index.name,
        ]);
        expect([...row]).toEqual([]);
      } finally {
        if (held.type === "claimed") {
          await held.release();
        }
        await main.sql.unsafe("DELETE FROM online_work_state");
        await holder.release();
        await claimer.release();
      }
    });
  });
});
