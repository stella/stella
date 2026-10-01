import { describe, expect, test } from "bun:test";

import { defaultConfig } from "../../../../packages/db-load-gate/src/health";
import {
  AUTOVACUUM_SQL,
  LONG_TRANSACTION_SQL,
  autovacuumOnTarget,
  longTransaction,
} from "../../../../packages/db-load-gate/src/indicators";
import { withGatedTestClients } from "../tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled || databaseUrl === undefined)(
  "real database health readings",
  () => {
    test("database scope stops on an unrelated transaction while table scope excludes it", async () => {
      if (databaseUrl === undefined) {
        throw new TypeError("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const holder = await openClient().sql.reserve();
        const observer = await openClient().sql.reserve();
        try {
          await holder`CREATE TEMP TABLE unrelated_health_probe (id integer)`;
          await observer`CREATE TEMP TABLE target_health_probe (id integer)`;
          await holder`BEGIN`;
          await holder`SELECT * FROM unrelated_health_probe`;
          const read = async (scope: "database" | "table", target: string) =>
            (
              await observer.unsafe<{ ageMs: number; observedAt: string }[]>(
                LONG_TRANSACTION_SQL,
                [scope, target],
              )
            ).at(0) ?? null;
          const databaseReading = await read("database", "target_health_probe");
          expect(databaseReading).not.toBeNull();
          if (databaseReading === null) {
            throw new TypeError("Missing transaction reading");
          }
          expect(databaseReading.ageMs).toBeGreaterThan(0);
          const config = { ...defaultConfig, longTxMaxAgeMs: Number.MIN_VALUE };
          const now = () => Date.parse(databaseReading.observedAt);
          expect(
            (
              await longTransaction({
                read: async () => databaseReading,
                now,
                config,
              })
            ).kind,
          ).toBe("stop");
          const targetReading = await read("table", "target_health_probe");
          expect(targetReading?.ageMs).toBe(0);
          await holder`ROLLBACK`;
        } finally {
          await holder`ROLLBACK`;
          holder.release();
          observer.release();
        }
      });
    });

    test("table scope stops on a transaction holding the target relation", async () => {
      if (databaseUrl === undefined) {
        throw new TypeError("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const holder = await openClient().sql.reserve();
        const observer = await openClient().sql.reserve();
        const target = `health_probe_${Bun.randomUUIDv7().replaceAll("-", "")}`;
        try {
          await observer.unsafe(`CREATE TABLE "${target}" (id integer)`);
          await holder`BEGIN`;
          await holder.unsafe(`SELECT * FROM "${target}"`);
          const reading = (
            await observer.unsafe<{ ageMs: number; observedAt: string }[]>(
              LONG_TRANSACTION_SQL,
              ["table", target],
            )
          ).at(0);
          if (reading === undefined) {
            throw new TypeError("Missing transaction reading");
          }
          expect(reading.ageMs).toBeGreaterThan(0);
          expect(
            (
              await longTransaction({
                read: async () => reading,
                now: () => Date.parse(reading.observedAt),
                config: { ...defaultConfig, longTxMaxAgeMs: Number.MIN_VALUE },
              })
            ).kind,
          ).toBe("stop");
        } finally {
          await holder`ROLLBACK`;
          await observer.unsafe(`DROP TABLE IF EXISTS "${target}"`);
          holder.release();
          observer.release();
        }
      });
    });

    test("production catalog query detects both vacuum and analyze and rejects unrelated workers", async () => {
      if (databaseUrl === undefined) {
        throw new TypeError("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const observer = await openClient().sql.reserve();
        try {
          await observer`CREATE TEMP TABLE vacuum_health_probe (id integer)`;
          const absent = (
            await observer.unsafe<{ active: boolean; observedAt: string }[]>(
              AUTOVACUUM_SQL,
              ["vacuum_health_probe"],
            )
          ).at(0);
          if (absent === undefined) {
            throw new TypeError("Missing catalog result");
          }
          expect(absent.active).toBe(false);
          // Derive fixture column types from the real catalogs. CTEs replace only
          // the catalog sources, so the production joins and predicates execute.
          // Scheduling a real autovacuum worker is not deterministic.
          await observer`CREATE TEMP TABLE seeded_activity AS SELECT pid, backend_type FROM pg_stat_activity WITH NO DATA`;
          await observer`CREATE TEMP TABLE seeded_vacuum AS SELECT pid, datid, relid FROM pg_stat_progress_vacuum WITH NO DATA`;
          await observer`CREATE TEMP TABLE seeded_analyze AS SELECT pid, datid, relid FROM pg_stat_progress_analyze WITH NO DATA`;
          const catalogQuery = `WITH pg_stat_activity AS (SELECT * FROM seeded_activity), pg_stat_progress_vacuum AS (SELECT * FROM seeded_vacuum), pg_stat_progress_analyze AS (SELECT * FROM seeded_analyze) ${AUTOVACUUM_SQL}`;
          for (const source of ["seeded_vacuum", "seeded_analyze"] as const) {
            await observer`TRUNCATE seeded_activity, seeded_vacuum, seeded_analyze`;
            await observer`INSERT INTO seeded_activity VALUES (2147483600, 'autovacuum worker')`;
            await observer.unsafe(
              `INSERT INTO ${source} SELECT 2147483600, oid, to_regclass('vacuum_health_probe') FROM pg_database WHERE datname = current_database()`,
            );
            const read = async () =>
              (
                await observer.unsafe<
                  { active: boolean; observedAt: string }[]
                >(catalogQuery, ["vacuum_health_probe"])
              ).at(0) ?? null;
            const active = await read();
            if (active === null) {
              throw new TypeError("Missing seeded catalog reading");
            }
            expect(active.active).toBe(true);
            expect(
              (
                await autovacuumOnTarget({
                  read: async () => active,
                  now: () => Date.parse(active.observedAt),
                  config: defaultConfig,
                  kind: "index_build",
                })
              ).kind,
            ).toBe("stop");
            expect(
              (
                await autovacuumOnTarget({
                  read: async () => active,
                  now: () => Date.parse(active.observedAt),
                  config: defaultConfig,
                  kind: "backfill_batch",
                })
              ).kind,
            ).toBe("degraded");
            await observer`UPDATE seeded_activity SET pid = 2147483599`;
            expect((await read())?.active).toBe(false);
            await observer`UPDATE seeded_activity SET pid = 2147483600`;
            await observer`UPDATE seeded_activity SET backend_type = 'client backend'`;
            expect((await read())?.active).toBe(false);
            await observer`UPDATE seeded_activity SET backend_type = 'autovacuum worker'`;
            await observer.unsafe(`UPDATE ${source} SET relid = 0`);
            expect((await read())?.active).toBe(false);
            await observer.unsafe(
              `UPDATE ${source} SET relid = to_regclass('vacuum_health_probe'), datid = 0`,
            );
            expect((await read())?.active).toBe(false);
          }
        } finally {
          observer.release();
        }
      });
    });

    test("active autovacuum transactions participate in the production database-wide gate", async () => {
      if (databaseUrl === undefined) {
        throw new TypeError("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const observer = await openClient().sql.reserve();
        try {
          await observer`CREATE TEMP TABLE seeded_activity AS SELECT pid, datname, xact_start, backend_type, state FROM pg_stat_activity WITH NO DATA`;
          await observer`INSERT INTO seeded_activity SELECT 2147483600, current_database(), clock_timestamp() - interval '10 minutes', 'autovacuum worker', 'active'`;
          const catalogQuery = `WITH pg_stat_activity AS (SELECT * FROM seeded_activity) ${LONG_TRANSACTION_SQL}`;
          const read = async () =>
            (
              await observer.unsafe<{ ageMs: number; observedAt: string }[]>(
                catalogQuery,
                ["database", "unused"],
              )
            ).at(0) ?? null;
          const active = await read();
          if (active === null) {
            throw new TypeError("Missing seeded transaction reading");
          }
          expect(active.ageMs).toBeGreaterThan(defaultConfig.longTxMaxAgeMs);
          expect(
            (
              await longTransaction({
                read: async () => active,
                now: () => Date.parse(active.observedAt),
                config: defaultConfig,
              })
            ).kind,
          ).toBe("stop");
          await observer`UPDATE seeded_activity SET state = 'idle'`;
          expect((await read())?.ageMs).toBe(0);
        } finally {
          observer.release();
        }
      });
    });
  },
);
