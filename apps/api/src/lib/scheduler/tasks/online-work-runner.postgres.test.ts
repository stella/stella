import { panic } from "better-result";
import type { ReservedSQL } from "bun";
import { describe, expect, test } from "bun:test";

import { defaultConfig } from "@stll/db-load-gate/health";

import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { declaresOnlineBuild } from "../../../db/online-ddl";
import type { OnlineIndexDeclaration } from "../../../db/online-ddl";
import type { OnlineIndexGateOptions } from "../../../db/online-index-gate";
import type { OnlineMigrationConnection } from "../../../db/online-migration-connection";
import {
  claimOnlineWorkUnit,
  ONLINE_MIGRATION_INDEXES,
  ONLINE_WORK_NAMES,
} from "../../../db/online-migrations";
import {
  ONLINE_WORK_LIFECYCLE,
  PENDING,
} from "../../../db/online-work-lifecycle";
import { withGatedTestClients } from "../../../tests/gated-test-database";
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
  const indexes: readonly OnlineIndexDeclaration[] = ONLINE_MIGRATION_INDEXES;
  return (
    indexes.find(declaresOnlineBuild) ??
    panic("Expected a buildable online index")
  );
};

const adapter = (session: ReservedSQL): OnlineMigrationConnection => ({
  execute: async (query, params = []) => {
    await session.unsafe(query, [...params]);
  },
  query: async (query, params = []) => await session.unsafe(query, [...params]),
  release: () => undefined,
});

const healthyGate = (): OnlineIndexGateOptions => ({
  config: {
    health: { ...defaultConfig, busyWindows: [], longTxMaxAgeMs: 3_600_000 },
    pollMs: 10,
    retryMs: 10,
    maxSnapshotWaitMs: 600_000,
    clientConnectionCheckMs: 10,
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
        const work: Promise<void>[] = [];
        try {
          await main.sql.unsafe(
            `DROP INDEX CONCURRENTLY IF EXISTS public."${index.name}"`,
          );
          const lifecycle = { ...ONLINE_WORK_LIFECYCLE, [index.name]: PENDING };
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

          expect(await runner(TICK)).toEqual({
            type: "started",
            name: index.name,
          });
          await Promise.all(work);

          const built = await main.sql.unsafe<
            { valid: boolean; ready: boolean }[]
          >(
            `SELECT state.indisvalid AS valid, state.indisready AS ready
             FROM pg_index state
             JOIN pg_class relation ON relation.oid = state.indexrelid
             WHERE relation.relname = $1`,
            [index.name],
          );
          expect(built).toEqual([{ valid: true, ready: true }]);
          const row = await main.sql.unsafe<
            { state: string; attempts: number }[]
          >("SELECT state, attempts FROM online_work_state WHERE name = $1", [
            index.name,
          ]);
          expect(row).toEqual([{ state: "finalized", attempts: 1 }]);
          expect(await runner(TICK)).toEqual({ type: "idle" });
        } finally {
          await main.sql.unsafe("DELETE FROM online_work_state");
          const present = await main.sql.unsafe<{ present: boolean }[]>(
            "SELECT to_regclass($1) IS NOT NULL AS present",
            [`public."${index.name}"`],
          );
          if (present.at(0)?.present !== true) {
            await main.sql.unsafe(index.createSql);
          }
          builder.release();
          observer.release();
        }
      },
      { closeMode: "force" },
    );
  });

  test("a tick skips while another session holds the online lock", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL is required");
    }
    const index = pendingIndex();
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const main = openClient({ max: 2 });
      const holder = await openClient().sql.reserve();
      const claimer = await openClient().sql.reserve();
      const lifecycle = { ...ONLINE_WORK_LIFECYCLE, [index.name]: PENDING };
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

        expect(await runner(TICK)).toEqual({ type: "skipped" });
        const row = await main.sql.unsafe<
          { state: string; attempts: number }[]
        >("SELECT state, attempts FROM online_work_state WHERE name = $1", [
          index.name,
        ]);
        expect(row).toEqual([]);
      } finally {
        if (held.type === "claimed") {
          await held.release();
        }
        await main.sql.unsafe("DELETE FROM online_work_state");
        holder.release();
        claimer.release();
      }
    });
  });
});
