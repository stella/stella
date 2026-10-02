import { panic, Result } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { defaultConfig } from "@stll/db-load-gate/health";

import { createDatabaseLoadVerdictReader } from "@/api/db/backfill-runtime";
import type { Transaction } from "@/api/db/root";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import {
  openGatedTestDatabase,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const restrictedRunner = (db: GatedTestDb, role: string, schema: string) => ({
  transaction: async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
      await tx.execute(sql.raw(`SET LOCAL search_path TO ${schema}, public`));
      const visibility = (
        await tx.execute(sql`
        SELECT current_user AS role,
          pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')
          OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) AS visible
      `)
      ).at(0);
      expect(visibility?.["role"]).toBe(role);
      expect(visibility?.["visible"]).toBe(false);
      return await fn(asTestRaw<Transaction>(tx));
    }),
});

describe.skipIf(!enabled || databaseUrl === undefined)(
  "database load admission through bounded indicator function",
  () => {
    if (databaseUrl === undefined) {
      return;
    }
    const fixture = openGatedTestDatabase(databaseUrl, { max: 1 });
    const { db } = fixture;
    const suffix = Bun.randomUUIDv7().replaceAll("-", "");
    const schema = `load_reader_${suffix}`;
    const role = `load_reader_noexec_${suffix}`;
    const target = `${schema}.target`;
    const config = {
      ...defaultConfig,
      busyWindows: [],
      longTxMaxAgeMs: Number.MIN_VALUE,
    };
    fixture.cleanUp(async () => {
      await db.execute(sql.raw(`DROP SCHEMA ${schema} CASCADE`));
      await db.execute(sql.raw(`DROP ROLE ${role}`));
    });
    beforeAll(async () => {
      const version = (
        await db.execute(
          sql`SELECT current_setting('server_version_num')::int AS version`,
        )
      ).at(0);
      expect(version?.["version"]).toBeGreaterThanOrEqual(180_000);
      expect(version?.["version"]).toBeLessThan(190_000);
      const migration = await Bun.file(
        new URL(
          "../../drizzle/20261003123600_database_load_indicators/migration.sql",
          import.meta.url,
        ),
      ).text();
      await db.transaction(async (tx) => {
        const existing = (
          await tx.execute(
            sql`SELECT to_regprocedure('public.stella_database_load_indicators(regclass)') IS NOT NULL AS installed`,
          )
        ).at(0);
        if (existing?.["installed"] === true) {
          return;
        }
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim().length > 0) {
            await tx.execute(sql.raw(statement));
          }
        }
      });
      await db.execute(sql.raw(`CREATE SCHEMA ${schema}`));
      await db.execute(
        sql.raw(`CREATE TABLE ${target} (id integer, payload text)`),
      );
      await db.execute(
        sql.raw(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOINHERIT`),
      );
      await db.execute(sql.raw(`GRANT ${role} TO CURRENT_USER`));
      await db.execute(
        sql.raw(`GRANT USAGE ON SCHEMA ${schema} TO stella_ingestion, ${role}`),
      );
      // Caller-visible lookalikes must not supply the function's observations.
      for (const name of [
        "pg_stat_activity",
        "pg_stat_progress_vacuum",
        "pg_stat_progress_analyze",
        "pg_database",
      ]) {
        await db.execute(
          sql.raw(`CREATE TABLE ${schema}.${name} (unexpected integer)`),
        );
      }
    });

    test("the function returns only its three indicators with a fixed catalog search path", async () => {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
        await tx.execute(sql.raw(`SET LOCAL search_path TO ${schema}, public`));
        const row = (
          await tx.execute(
            sql`SELECT * FROM public.stella_database_load_indicators(${target}::regclass)`,
          )
        ).at(0);
        if (row === undefined) {
          return panic("Missing load indicator row");
        }
        expect(Object.keys(row).toSorted()).toEqual([
          "observed_at",
          "transaction_age_ms",
          "vacuum_active",
        ]);
        expect(typeof row["transaction_age_ms"]).toBe("number");
        expect(row["transaction_age_ms"]).toBeGreaterThanOrEqual(0);
        expect(row["vacuum_active"]).toBe(false);
        expect(row["observed_at"]).toBeInstanceOf(Date);
      });
      const definition = (
        await db.execute(sql`
        SELECT p.prosecdef AS definer, p.proconfig AS configuration,
          r.rolsuper OR pg_has_role(r.oid, 'pg_read_all_stats', 'USAGE') AS owner_visible,
          pg_get_function_result(p.oid) AS result
        FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.oid = 'public.stella_database_load_indicators(regclass)'::regprocedure
      `)
      ).at(0);
      expect(definition?.["definer"]).toBe(true);
      expect(definition?.["owner_visible"]).toBe(true);
      expect(definition?.["configuration"]).toEqual([
        "search_path=pg_catalog, pg_temp",
      ]);
      expect(definition?.["result"]).toBe(
        "TABLE(transaction_age_ms double precision, vacuum_active boolean, observed_at timestamp with time zone)",
      );
    });

    test("ingestion receives the age of another role's real transaction despite caller lookalikes", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const holder = await openClient().sql.reserve();
        try {
          await holder`BEGIN`;
          await holder.unsafe(`SELECT * FROM ${target}`);
          const holderState = (
            await holder`SELECT current_user AS role, pg_backend_pid() AS pid`
          ).at(0);
          expect(holderState?.["role"]).not.toBe("stella_ingestion");
          const holderAge = (
            await holder`SELECT (extract(epoch FROM clock_timestamp() - transaction_timestamp()) * 1000)::float8 AS age`
          ).at(0)?.["age"];
          if (typeof holderAge !== "number") {
            return panic("Missing holder transaction age");
          }
          expect(holderAge).toBeGreaterThan(0);
          const read = createDatabaseLoadVerdictReader({
            db: restrictedRunner(db, "stella_ingestion", schema),
            tableName: target,
            config,
          });
          const verdict = await read();
          const transaction = verdict.signals.find(
            (signal) => signal.indicator === "long_transaction",
          );
          expect(transaction?.kind).toBe("stop");
          expect(transaction?.value).toBeGreaterThan(0);
          expect(transaction?.value).toBeGreaterThanOrEqual(holderAge);
          expect(transaction?.observedAt).not.toBeNull();
        } finally {
          await holder`ROLLBACK`;
          holder.release();
        }
      });
    });

    test("a role without function execute returns unknown and never reports normal load", async () => {
      const rights = (
        await db.execute(
          sql`SELECT has_function_privilege(${role}, 'public.stella_database_load_indicators(regclass)', 'EXECUTE') AS executable`,
        )
      ).at(0);
      expect(rights?.["executable"]).toBe(false);
      const verdict = await createDatabaseLoadVerdictReader({
        db: restrictedRunner(db, role, schema),
        tableName: target,
        config,
      })();
      expect(verdict).toEqual({
        kind: "unknown",
        signals: [
          {
            indicator: "long_transaction",
            kind: "unknown",
            value: null,
            threshold: null,
            observedAt: null,
            reason: "Database indicators are unavailable",
          },
        ],
      });
    });

    test("ingestion detects a real active vacuum on the target and excludes other relations", async () => {
      await db.execute(
        sql.raw(`ALTER TABLE ${target} ALTER COLUMN payload SET STORAGE PLAIN`),
      );
      await db.execute(
        sql.raw(
          `INSERT INTO ${target} SELECT id, repeat(md5(id::text), 100) FROM generate_series(1, 2048) id`,
        ),
      );
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const worker = await openClient({
          connection: { statement_timeout: 30_000 },
        }).sql.reserve();
        const observer = await openClient().sql.reserve();
        let vacuum: ReturnType<typeof Result.tryPromise> | undefined;
        try {
          await worker`SET vacuum_cost_delay = 50`;
          await worker`SET vacuum_cost_limit = 1`;
          const pid = (await worker`SELECT pg_backend_pid() AS pid`).at(0)?.[
            "pid"
          ];
          if (typeof pid !== "number") {
            return panic("Missing vacuum backend pid");
          }
          vacuum = Result.tryPromise(
            async () =>
              await worker.unsafe(
                `VACUUM (FREEZE, DISABLE_PAGE_SKIPPING) ${target}`,
              ),
          );
          const deadline = performance.now() + 5000;
          let running = false;
          // Synchronize on actual progress, rather than timing worker startup.
          while (!running && performance.now() < deadline) {
            const progress = (
              await observer`SELECT EXISTS (SELECT 1 FROM pg_stat_progress_vacuum WHERE pid = ${pid} AND relid = ${target}::regclass) AS running`
            ).at(0);
            running = progress?.["running"] === true;
            if (!running) {
              await Bun.sleep(10);
            }
          }
          expect(running).toBe(true);
          const read = createDatabaseLoadVerdictReader({
            db: restrictedRunner(db, "stella_ingestion", schema),
            tableName: target,
            config,
          });
          const signal = (await read()).signals.find(
            (entry) => entry.indicator === "autovacuum_on_target",
          );
          expect(signal?.kind).toBe("degraded");
          expect(signal?.value).toBe(1);
          await db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
            const other = (
              await tx.execute(
                sql`SELECT * FROM public.stella_database_load_indicators(${`${schema}.pg_database`}::regclass)`,
              )
            ).at(0);
            expect(other?.["vacuum_active"]).toBe(false);
          });
          expect(
            (await observer`SELECT pg_cancel_backend(${pid}) AS canceled`).at(
              0,
            )?.["canceled"],
          ).toBe(true);
          const outcome = await vacuum;
          expect(Result.isError(outcome)).toBe(true);
          if (Result.isError(outcome)) {
            expect(isPgError(outcome.error, PG_ERROR.QUERY_CANCELED)).toBe(
              true,
            );
          }
          vacuum = undefined;
        } finally {
          if (vacuum !== undefined) {
            const pid = (
              await observer`SELECT pid FROM pg_stat_progress_vacuum WHERE relid = ${target}::regclass`
            ).at(0)?.["pid"];
            if (typeof pid === "number") {
              await observer`SELECT pg_cancel_backend(${pid})`;
            }
            await vacuum;
          }
          worker.release();
          observer.release();
        }
      });
    }, 30_000);
  },
);
