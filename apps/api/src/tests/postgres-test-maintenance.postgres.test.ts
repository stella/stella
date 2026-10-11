import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  POSTGRES_LOCK_SNAPSHOT_SQL,
  startLockMonitor,
} from "../../scripts/postgres-lock-diagnostics";
import { POSTGRES_TEST_MAINTENANCE_SQL } from "../../scripts/postgres-test-maintenance";
import { openBoundedDatabaseObserver } from "../db/online-index-observer";
import { getPgErrorCode } from "../lib/pg-error";
import { withFreshIndicatorDatabase } from "./database-load-indicator-fixture";
import { withGatedTestClients } from "./gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)(
  "Postgres fixture maintenance and lock evidence",
  () => {
    test("bounded observers apply requested budgets and application name", async () => {
      if (!databaseUrl) {
        panic("Postgres observer test requires DATABASE_URL");
      }
      const observer = await openBoundedDatabaseObserver({
        url: databaseUrl,
        statementTimeoutMs: 1000,
        lockTimeoutMs: 100,
        applicationName: "stella_fixture_observer_test",
      });
      try {
        expect(
          (
            await observer.query(`SELECT
          current_setting('statement_timeout') AS statement_timeout,
          current_setting('lock_timeout') AS lock_timeout,
          current_setting('application_name') AS application_name`)
          ).at(0),
        ).toEqual({
          statement_timeout: "1s",
          lock_timeout: "100ms",
          application_name: "stella_fixture_observer_test",
        });
      } finally {
        await observer.release();
      }
    });
    test("fixture table maintenance is disabled without changing fresh database defaults", async () => {
      if (!databaseUrl) {
        panic("Postgres maintenance test requires DATABASE_URL");
      }
      await withFreshIndicatorDatabase(databaseUrl, async ({ client }) => {
        await client`CREATE TABLE public.fixture (id integer, payload text)`;
        await client.unsafe(POSTGRES_TEST_MAINTENANCE_SQL);
        const configured =
          await client`SELECT reloptions FROM pg_class WHERE oid = 'public.fixture'::regclass`;
        expect(configured.at(0)?.["reloptions"]).toContain(
          "autovacuum_enabled=false",
        );
        const toast =
          await client`SELECT t.reloptions FROM pg_class c JOIN pg_class t ON t.oid = c.reltoastrelid WHERE c.oid = 'public.fixture'::regclass`;
        expect(toast.at(0)?.["reloptions"]).toContain(
          "autovacuum_enabled=false",
        );
        expect((await client`SHOW autovacuum`).at(0)?.["autovacuum"]).toBe(
          "on",
        );
        await withFreshIndicatorDatabase(
          databaseUrl,
          async ({ client: fresh }) => {
            await fresh`CREATE TABLE public.fixture (id integer)`;
            const defaults =
              await fresh`SELECT reloptions FROM pg_class WHERE oid = 'public.fixture'::regclass`;
            expect(defaults.at(0)?.["reloptions"]).toBeNull();
            expect((await fresh`SHOW autovacuum`).at(0)?.["autovacuum"]).toBe(
              "on",
            );
          },
        );
      });
    });

    test("a lock timeout report retains the real waiting pid and its lock owner", async () => {
      if (!databaseUrl) {
        panic("Postgres diagnostics test requires DATABASE_URL");
      }
      await withFreshIndicatorDatabase(databaseUrl, async ({ client }) => {
        await client`CREATE TABLE public.fixture (id integer)`;
        const database = (await client`SELECT current_database() AS name`).at(
          0,
        )?.["name"];
        const url = new URL(databaseUrl);
        url.pathname = `/${database}`;
        await withGatedTestClients(url.toString(), async ({ openClient }) => {
          const observer = openClient().sql;
          const monitor = startLockMonitor({
            capture: async () => observer.unsafe(POSTGRES_LOCK_SNAPSHOT_SQL),
            intervalMs: 10,
          });
          let ready = () => {};
          let release = () => {};
          const acquired = new Promise<void>((resolve) => {
            ready = resolve;
          });
          const released = new Promise<void>((resolve) => {
            release = resolve;
          });
          let holderPid = 0;
          let waiterPid = 0;
          const holder = client.begin(async (tx) => {
            holderPid = (await tx`SELECT pg_backend_pid() AS pid`).at(0)?.[
              "pid"
            ];
            await tx`LOCK TABLE public.fixture IN SHARE UPDATE EXCLUSIVE MODE`;
            ready();
            await released;
          });
          try {
            await Promise.race([acquired, holder]);
            const wait = client.begin(async (tx) => {
              waiterPid = (await tx`SELECT pg_backend_pid() AS pid`).at(0)?.[
                "pid"
              ];
              await tx`SET LOCAL lock_timeout = '500ms'`;
              await tx`LOCK TABLE public.fixture IN ACCESS EXCLUSIVE MODE`;
            });
            const result = await Result.tryPromise(async () => wait);
            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
              expect(getPgErrorCode(result.error)).toBe("55P03");
            }
            const report = await monitor.stop();
            const snapshot = JSON.parse(JSON.parse(report).samples.at(-1));
            expect(snapshot.waiters).toContainEqual({
              pid: waiterPid,
              blockers: [holderPid],
            });
            expect(report).toContain("ShareUpdateExclusiveLock");
            expect(report).toContain("AccessExclusiveLock");
            expect(report).toContain("client backend");
          } finally {
            release();
            await holder;
            await monitor.stop();
          }
        });
      });
    });
  },
);
