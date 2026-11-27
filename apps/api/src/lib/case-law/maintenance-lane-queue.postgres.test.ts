/**
 * The lane's two scoped modes on a real Postgres, across sessions: a bounded
 * operator pass waits in the server's lock queue within its budget, and a
 * periodic tick tries once and skips. A session-level advisory lock is only
 * meaningful across sessions, so PGlite cannot stand in. The suite runs in its
 * own database clone (`EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS`): another suite
 * holding the same lane would move these timings.
 */
import { panic } from "better-result";
import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";

import { waitForExternalState } from "@stll/property-testing/external-state";
import { Temporal } from "@stll/time";

import {
  CASE_LAW_MAINTENANCE_LANE,
  enterCaseLawMaintenanceLane,
  holdCaseLawMaintenanceLane,
} from "@/api/lib/case-law/maintenance-lane";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const HOLDER_APPLICATION = "maintenance-lane-holder";
const now = () => Temporal.Now.instant().epochMilliseconds;

/** Statement budgets shorter than every lane wait below, so a wait they capped would fail. */
const STATEMENT_BUDGET = { statementTimeout: 500, lockTimeout: 500 } as const;

const backendPid = async (client: SQL): Promise<number> => {
  const pid = (
    await client.unsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid")
  ).at(0)?.pid;
  return pid ?? panic("Expected the holder's backend pid");
};

/** Sessions on the lane, granted or queued, from the catalog. */
const sessionsOnLane = async (
  observer: SQL,
  granted: boolean,
): Promise<number> =>
  (
    await observer.unsafe<{ sessions: number }[]>(
      `SELECT count(*)::integer AS sessions FROM pg_locks
        WHERE locktype = 'advisory' AND granted = $3
          AND classid = hashtext($1)::oid AND objid = hashtext($2)::oid AND objsubid = 2
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      [
        CASE_LAW_MAINTENANCE_LANE.domain,
        CASE_LAW_MAINTENANCE_LANE.lane,
        granted,
      ],
    )
  ).at(0)?.sessions ?? 0;

const queuedOnLane = async (observer: SQL) =>
  await sessionsOnLane(observer, false);
const lanesHeld = async (observer: SQL) => await sessionsOnLane(observer, true);

const waitUntilQueued = async (observer: SQL) =>
  await waitForExternalState({
    description: "an operator pass queues on the held lane",
    read: async () => (await queuedOnLane(observer)) > 0,
  });

/** One promise and the function that settles it: a gate the test opens. */
const gate = () => {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return { opened: promise, open: () => resolve(undefined) };
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("case-law maintenance lane queue (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("case-law maintenance lane queue (postgres)", () => {
    test("a bounded operator pass queues behind a holder and runs once it releases", async () => {
      await withGatedTestClients(
        databaseUrl,
        async ({ openClient }) => {
          const observer = openClient().sql;
          const held = await holdCaseLawMaintenanceLane({
            sql: openClient().sql,
          });
          const operator = enterCaseLawMaintenanceLane({
            mode: "bounded",
            laneWaitMs: 30_000,
            signal: AbortSignal.timeout(60_000),
            ...STATEMENT_BUDGET,
            work: async () => "operator ran",
          });
          await waitUntilQueued(observer);
          await held.release();
          expect(await operator).toEqual({
            status: "ran",
            value: "operator ran",
          });
        },
        { closeMode: "force" },
      );
    });

    test("a bounded operator pass refuses naming the holder once its budget runs out", async () => {
      await withGatedTestClients(
        databaseUrl,
        async ({ openClient }) => {
          const holderClient = openClient({
            connection: { application_name: HOLDER_APPLICATION },
          }).sql;
          const held = await holdCaseLawMaintenanceLane({ sql: holderClient });
          try {
            const holderPid = await backendPid(holderClient);
            const startedAt = now();
            const refused = await enterCaseLawMaintenanceLane({
              mode: "bounded",
              laneWaitMs: 1500,
              signal: AbortSignal.timeout(60_000),
              ...STATEMENT_BUDGET,
              work: async () =>
                panic("Work must not start while the lane is held"),
            });
            expect(now() - startedAt).toBeGreaterThanOrEqual(1400);
            expect(refused).toEqual({
              status: "busy",
              holder: expect.objectContaining({
                pid: holderPid,
                applicationName: HOLDER_APPLICATION,
              }),
            });
          } finally {
            await held.release();
          }
        },
        { closeMode: "force" },
      );
    });

    test("a periodic tick skips a held lane and never takes it ahead of a queued operator pass", async () => {
      await withGatedTestClients(
        databaseUrl,
        async ({ openClient }) => {
          const observer = openClient().sql;
          const holderClient = openClient().sql;
          const held = await holdCaseLawMaintenanceLane({ sql: holderClient });
          const holderPid = await backendPid(holderClient);
          const tick = async () =>
            await enterCaseLawMaintenanceLane({
              mode: "periodic",
              signal: AbortSignal.timeout(60_000),
              ...STATEMENT_BUDGET,
              work: async () => "tick ran",
            });

          expect(await tick()).toEqual({
            status: "busy",
            holder: expect.objectContaining({ pid: holderPid }),
          });

          const working = gate();
          const finish = gate();
          const operator = enterCaseLawMaintenanceLane({
            mode: "bounded",
            laneWaitMs: 30_000,
            signal: AbortSignal.timeout(60_000),
            ...STATEMENT_BUDGET,
            work: async () => {
              working.open();
              await finish.opened;
              return "operator ran";
            },
          });
          await waitUntilQueued(observer);
          expect((await tick()).status).toBe("busy");

          // The release hands the lane to the queued pass, never to a tick
          // that arrives after it.
          await held.release();
          const afterRelease = await tick();
          await working.opened;
          finish.open();
          expect(await operator).toEqual({
            status: "ran",
            value: "operator ran",
          });
          expect(afterRelease).toMatchObject({ status: "busy" });
          expect(afterRelease).not.toMatchObject({
            holder: { pid: holderPid },
          });
          // The operator's session ends on return; the server drops its lock
          // once that backend has gone, which this process does not observe.
          await waitForExternalState({
            description: "the operator pass's session has left the lane",
            read: async () => (await lanesHeld(observer)) === 0,
          });
          expect(await tick()).toEqual({ status: "ran", value: "tick ran" });
        },
        { closeMode: "force" },
      );
    });
  });
}
