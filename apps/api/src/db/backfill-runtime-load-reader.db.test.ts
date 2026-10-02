import { panic, Result } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";

import { defaultConfig } from "@stll/db-load-gate/health";
import {
  AUTOVACUUM_SQL,
  LONG_TRANSACTION_SQL,
} from "@stll/db-load-gate/indicators";

import { createDatabaseLoadVerdictReader } from "@/api/db/backfill-runtime";
import type { Transaction } from "@/api/db/root";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import { withFreshIndicatorDatabase } from "@/api/tests/database-load-indicator-fixture";
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
      await tx.execute(
        sql.raw(`SET LOCAL search_path TO ${schema}, pg_catalog, public`),
      );
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

describe.skipIf(!enabled)(
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
    const deniedTarget = `${schema}.denied_target`;
    const blindOwner = `load_reader_blind_${suffix}`;
    const config = {
      ...defaultConfig,
      busyWindows: [],
      longTxMaxAgeMs: Number.MIN_VALUE,
    };
    fixture.cleanUp(async () => {
      await db.execute(sql.raw(`DROP SCHEMA ${schema} CASCADE`));
      await db.execute(sql.raw(`DROP ROLE ${role}`));
      await db.execute(sql.raw(`DROP OWNED BY ${blindOwner}`));
      await db.execute(sql.raw(`DROP ROLE ${blindOwner}`));
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
      await db.execute(sql.raw(`CREATE TABLE ${deniedTarget} (id integer)`));
      await db.execute(
        sql.raw(
          `REVOKE SELECT ON ${deniedTarget} FROM PUBLIC, stella_ingestion`,
        ),
      );
      await db.execute(
        sql.raw(`GRANT SELECT ON ${target} TO stella_ingestion`),
      );
      await db.execute(
        sql.raw(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOINHERIT`),
      );
      await db.execute(sql.raw(`GRANT ${role} TO CURRENT_USER`));
      await db.execute(
        sql.raw(`GRANT USAGE ON SCHEMA ${schema} TO stella_ingestion, ${role}`),
      );
      await db.execute(
        sql.raw(`CREATE ROLE ${blindOwner} NOLOGIN NOSUPERUSER NOINHERIT`),
      );
      await db.execute(sql.raw(`GRANT ${blindOwner} TO CURRENT_USER`));
      await db.execute(
        sql.raw(`GRANT USAGE, CREATE ON SCHEMA public TO ${blindOwner}`),
      );
      for (const definition of [
        "clock_timestamp() RETURNS timestamptz LANGUAGE sql AS 'SELECT NULL::timestamptz'",
        "pg_backend_pid() RETURNS integer LANGUAGE sql AS 'SELECT -1'",
        "current_database() RETURNS name LANGUAGE sql AS 'SELECT NULL::name'",
      ]) {
        await db.execute(sql.raw(`CREATE FUNCTION ${schema}.${definition}`));
      }
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
        await db.execute(
          sql.raw(`GRANT SELECT ON ${schema}.${name} TO stella_ingestion`),
        );
      }
    });

    test("the function returns only its three indicators with a fixed catalog search path", async () => {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
        await tx.execute(
          sql.raw(`SET LOCAL search_path TO ${schema}, pg_catalog, public`),
        );
        const access = (
          await tx.execute(
            sql`SELECT pg_catalog.has_table_privilege('stella_ingestion', ${target}::regclass, 'SELECT') AS permitted`,
          )
        ).at(0);
        expect(access?.["permitted"]).toBe(true);
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
        SELECT p.prosecdef AS definer, p.provolatile AS volatility, p.proconfig AS configuration,
          r.rolsuper OR pg_has_role(r.oid, 'pg_read_all_stats', 'USAGE') AS owner_visible,
          pg_get_function_result(p.oid) AS result
        FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.oid = 'public.stella_database_load_indicators(regclass)'::regprocedure
      `)
      ).at(0);
      expect(definition?.["definer"]).toBe(true);
      expect(definition?.["volatility"]).toBe("v");
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
          // Observe the direct query from an independent backend.
          const observer = openClient().sql;
          const visible = (
            await observer.unsafe(LONG_TRANSACTION_SQL, ["table", target])
          ).at(0);
          expect(visible?.["ageMs"]).toBeGreaterThan(0);
          const aggregate = (
            await observer.unsafe(
              "SELECT * FROM public.stella_database_load_indicators($1::regclass)",
              [target],
            )
          ).at(0);
          const age = visible?.["ageMs"];
          const aggregateAge = aggregate?.["transaction_age_ms"];
          if (typeof age !== "number" || typeof aggregateAge !== "number") {
            panic("Missing scoped transaction ages");
          }
          expect(aggregateAge).toBeGreaterThanOrEqual(age);
          expect(aggregateAge - age).toBeLessThan(1000);
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

    test("the non-superuser execute grantee cannot read indicators for an inaccessible target", async () => {
      const permissions = (
        await db.execute(sql`
        SELECT
          pg_catalog.has_table_privilege(session_user, ${deniedTarget}::regclass, 'SELECT') AS login_permitted,
          pg_catalog.has_table_privilege('stella_ingestion', ${deniedTarget}::regclass, 'SELECT') AS grantee_permitted,
          pg_catalog.has_function_privilege('stella_ingestion', 'public.stella_database_load_indicators(regclass)', 'EXECUTE') AS executable,
          (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = 'stella_ingestion') AS superuser
      `)
      ).at(0);
      expect(permissions).toEqual({
        login_permitted: true,
        grantee_permitted: false,
        executable: true,
        superuser: false,
      });
      const warnings: unknown[][] = [];
      const warn = (...record: unknown[]) => {
        warnings.push(record);
      };
      const read = createDatabaseLoadVerdictReader({
        db: restrictedRunner(db, "stella_ingestion", schema),
        tableName: deniedTarget,
        config,
        warn,
        clock: () => Date.now() + 48 * 60 * 60_000,
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        // db-await-in-loop: repeat failure serially to verify the warning is rate-limited.
        const verdict = await read();
        expect(verdict.kind).toBe("unknown");
        expect(verdict.signals).toEqual([
          {
            indicator: "long_transaction",
            kind: "unknown",
            value: null,
            threshold: null,
            observedAt: null,
            reason: "Database indicators are unavailable",
          },
        ]);
      }
      expect(warnings).toEqual([
        [
          "database_load_gate.indicators_unavailable",
          { failureCause: "target_access_denied", sqlState: "42501" },
        ],
      ]);
    });

    for (const failure of [
      "function missing",
      "owner lacks statistics visibility",
    ] as const) {
      test(`${failure} holds and warns with a bounded cause`, async () => {
        const warnings: unknown[][] = [];
        const warn = (...record: unknown[]) => {
          warnings.push(record);
        };
        const outcome = await Result.tryPromise(
          async () =>
            await db.transaction(async (tx) => {
              if (failure === "function missing") {
                await tx.execute(
                  sql.raw(
                    `ALTER FUNCTION public.stella_database_load_indicators(regclass) RENAME TO load_indicators_${suffix}`,
                  ),
                );
              } else {
                const visible = (
                  await tx.execute(
                    sql`SELECT pg_has_role(${blindOwner}, 'pg_read_all_stats', 'USAGE') AS visible`,
                  )
                ).at(0);
                expect(visible?.["visible"]).toBe(false);
                await tx.execute(
                  sql.raw(
                    `ALTER FUNCTION public.stella_database_load_indicators(regclass) OWNER TO ${blindOwner}`,
                  ),
                );
              }
              const verdict = await createDatabaseLoadVerdictReader({
                db: {
                  transaction: async (fn) =>
                    await fn(asTestRaw<Transaction>(tx)),
                },
                tableName: target,
                config,
                warn,
                clock: () => Date.now() + 24 * 60 * 60_000,
              })();
              expect(verdict.kind).toBe("unknown");
              expect(verdict.signals.at(0)?.reason).toBe(
                "Database indicators are unavailable",
              );
              expect(warnings).toEqual([
                [
                  "database_load_gate.indicators_unavailable",
                  {
                    failureCause:
                      failure === "function missing"
                        ? "function_missing"
                        : "owner_lacks_visibility",
                    sqlState:
                      failure === "function missing" ? "42883" : "42501",
                  },
                ],
              ]);
              // Restore the shared function atomically, including on failed assertions.
              tx.rollback();
            }),
        );
        if (Result.isOk(outcome)) {
          panic("Expected explicit fixture rollback");
        }
        if (!(outcome.error instanceof TransactionRollbackError)) {
          throw outcome.error;
        }
      });
    }

    test("an unrelated transaction is absent from both scoped indicator reads", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const holder = await openClient().sql.reserve();
        const observer = openClient().sql;
        try {
          await holder`BEGIN`;
          await holder.unsafe(`SELECT * FROM ${schema}.pg_database`);
          const direct = (
            await observer.unsafe(LONG_TRANSACTION_SQL, ["table", target])
          ).at(0);
          const aggregate = (
            await observer.unsafe(
              "SELECT * FROM public.stella_database_load_indicators($1::regclass)",
              [target],
            )
          ).at(0);
          expect(direct?.["ageMs"]).toBe(0);
          expect(aggregate?.["transaction_age_ms"]).toBe(0);
        } finally {
          await holder`ROLLBACK`;
          holder.release();
        }
      });
    });

    test("manual vacuum is excluded just as in the direct autovacuum indicator", async () => {
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
          expect(signal?.kind).toBe("normal");
          expect(signal?.value).toBe(0);
          const direct = (await observer.unsafe(AUTOVACUUM_SQL, [target])).at(
            0,
          );
          expect(direct?.["active"]).toBe(false);
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

describe.skipIf(!enabled)(
  "fresh indicator migration and real automatic maintenance",
  () => {
    if (databaseUrl === undefined) {
      return;
    }

    test("checked-in definition grants effective execute only to owner and ingestion", async () => {
      await withFreshIndicatorDatabase(
        databaseUrl,
        async ({ client, migration, unrelatedRole }) => {
          const definition = (
            await client`
        SELECT prosrc, owner.rolname AS owner,
          pg_has_role(owner.oid, 'pg_read_all_stats', 'USAGE') OR owner.rolsuper AS visible
        FROM pg_proc AS procedure JOIN pg_roles AS owner ON owner.oid = procedure.proowner
        WHERE procedure.oid = 'public.stella_database_load_indicators(regclass)'::regprocedure
      `
          ).at(0);
          expect(definition?.["prosrc"]).toBe(
            migration.split("AS $$").at(1)?.split("$$;").at(0),
          );
          expect(definition?.["visible"]).toBe(true);
          const grants = await client`
        SELECT COALESCE(role.rolname, 'PUBLIC') AS grantee, acl.privilege_type, acl.is_grantable
        FROM pg_proc AS procedure
        CROSS JOIN LATERAL aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) AS acl
        LEFT JOIN pg_roles AS role ON role.oid = acl.grantee
        WHERE procedure.oid = 'public.stella_database_load_indicators(regclass)'::regprocedure
        ORDER BY grantee
      `;
          expect(Array.from(grants)).toEqual(
            [
              {
                grantee: definition?.["owner"],
                privilege_type: "EXECUTE",
                is_grantable: false,
              },
              {
                grantee: "stella_ingestion",
                privilege_type: "EXECUTE",
                is_grantable: false,
              },
            ].toSorted((a, b) => {
              const first = String(a.grantee);
              const second = String(b.grantee);
              if (first === second) {
                return 0;
              }
              return first < second ? -1 : 1;
            }),
          );
          const permissions = (
            await client`
        SELECT has_function_privilege(${unrelatedRole}, 'public.stella_database_load_indicators(regclass)', 'EXECUTE') AS unrelated,
          has_function_privilege('stella_ingestion', 'public.stella_database_load_indicators(regclass)', 'EXECUTE') AS ingestion
      `
          ).at(0);
          expect(permissions?.["unrelated"]).toBe(false);
          expect(permissions?.["ingestion"]).toBe(true);
        },
      );
    }, 15_000);

    test("real autovacuum and autoanalyze on A degrade only A", async () => {
      await withFreshIndicatorDatabase(databaseUrl, async ({ client, db }) => {
        await client.unsafe(`CREATE TABLE public.target_a (id integer, payload text) WITH (
        autovacuum_enabled = true, autovacuum_vacuum_threshold = 0,
        autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_insert_threshold = 0,
        autovacuum_vacuum_insert_scale_factor = 0, autovacuum_analyze_threshold = 0,
        autovacuum_analyze_scale_factor = 0, autovacuum_vacuum_cost_delay = 10,
        autovacuum_vacuum_cost_limit = 1)`);
        await client.unsafe(
          "ALTER TABLE public.target_a ALTER COLUMN payload SET STORAGE PLAIN",
        );
        await client.unsafe(
          "ALTER TABLE public.target_a ALTER COLUMN payload SET STATISTICS 1000",
        );
        await client.unsafe(
          "CREATE TABLE public.target_b (id integer) WITH (autovacuum_enabled = false)",
        );
        await client.unsafe(
          "GRANT SELECT ON public.target_a, public.target_b TO stella_ingestion",
        );
        const config = { ...defaultConfig, busyWindows: [] };
        const readEbsSignal = async () =>
          ({
            indicator: "ebs_balance",
            kind: "normal",
            value: 100,
            threshold: 70,
            observedAt: new Date().toISOString(),
            reason: "External EBS boundary fixture",
          }) as const;
        const reader = (tableName: string) =>
          createDatabaseLoadVerdictReader({
            db: restrictedRunner(db, "stella_ingestion", "public"),
            tableName,
            config,
            readEbsSignal,
          });
        const readA = reader("public.target_a");
        const readB = reader("public.target_b");
        await client.unsafe(
          "INSERT INTO public.target_a SELECT id, repeat(md5(id::text), 100) FROM generate_series(1, 512) AS id",
        );
        await client`SELECT pg_stat_force_next_flush()`;
        const seen = new Set<string>();
        const deadline = performance.now() + 110_000;
        while (seen.size < 2 && performance.now() < deadline) {
          const progress = await client`
          SELECT 'vacuum' AS phase, progress.pid FROM pg_stat_progress_vacuum AS progress
          JOIN pg_stat_activity AS worker USING (pid)
          WHERE progress.relid = 'public.target_a'::regclass AND worker.backend_type = 'autovacuum worker'
            AND progress.datid = (SELECT oid FROM pg_database WHERE datname = current_database())
          UNION ALL
          SELECT 'analyze' AS phase, progress.pid FROM pg_stat_progress_analyze AS progress
          JOIN pg_stat_activity AS worker USING (pid)
          WHERE progress.relid = 'public.target_a'::regclass AND worker.backend_type = 'autovacuum worker'
            AND progress.datid = (SELECT oid FROM pg_database WHERE datname = current_database())
        `;
          for (const row of progress) {
            const phase = row["phase"];
            if (typeof phase !== "string" || seen.has(phase)) {
              continue;
            }
            const direct = (
              await client`SELECT vacuum_active FROM public.stella_database_load_indicators('public.target_a'::regclass)`
            ).at(0);
            const verdict = await readA();
            const stillActive = (
              await client`
            SELECT EXISTS (SELECT 1 FROM pg_stat_progress_vacuum WHERE pid = ${row["pid"]} AND ${phase} = 'vacuum'
              UNION ALL SELECT 1 FROM pg_stat_progress_analyze WHERE pid = ${row["pid"]} AND ${phase} = 'analyze') AS active
          `
            ).at(0);
            if (stillActive?.["active"] !== true) {
              continue;
            }
            expect(direct?.["vacuum_active"]).toBe(true);
            expect(verdict.kind).toBe("degraded");
            expect(
              verdict.signals.find(
                ({ indicator }) => indicator === "autovacuum_on_target",
              ),
            ).toMatchObject({ kind: "degraded", value: 1 });
            const other = (
              await client`SELECT vacuum_active FROM public.stella_database_load_indicators('public.target_b'::regclass)`
            ).at(0);
            expect(other?.["vacuum_active"]).toBe(false);
            expect((await readB()).kind).toBe("normal");
            seen.add(phase);
          }
          if (seen.size < 2) {
            await Bun.sleep(10);
          }
        }
        if (seen.size !== 2) {
          const settings =
            await client`SELECT current_setting('autovacuum') AS enabled, current_setting('autovacuum_naptime') AS naptime`;
          const statistics =
            await client`SELECT n_dead_tup, n_ins_since_vacuum, n_mod_since_analyze, autovacuum_count, autoanalyze_count FROM pg_stat_user_tables WHERE relid = 'public.target_a'::regclass`;
          panic(
            `Real automatic maintenance witness missing: observed=${JSON.stringify(Array.from(seen))}; settings=${JSON.stringify(settings)}; statistics=${JSON.stringify(statistics)}`,
          );
        }
        expect(Array.from(seen).toSorted()).toEqual(["analyze", "vacuum"]);
      });
    }, 120_000);
  },
);
