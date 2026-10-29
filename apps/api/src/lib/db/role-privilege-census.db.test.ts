import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { withIsolatedPostgresCluster } from "@/api/tests/isolated-postgres-cluster";

import { runMigrations } from "../../db/migration-runner";
import {
  assertCompleteCensus,
  type Census,
  readExpectedCensus,
  readRolePrivilegeCensus,
} from "./role-privilege-census";

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const describePostgres = describe.skipIf(!runPostgresTests);
const migrationsFolder = path.resolve(import.meta.dir, "../../../drizzle");

const withMigratedDatabase = async (
  run: (database: SQL, census: Census) => Promise<void>,
) => {
  await withIsolatedPostgresCluster(
    {
      prefix: "role-census",
      database: "stella",
      user: "census_admin",
      password: "fixture",
    },
    async (scratchUrl) => {
      await withGatedTestClients(scratchUrl, async ({ openClient }) => {
        const database = openClient().sql;
        const connection = await database.reserve();
        try {
          await runMigrations({
            connection,
            databaseUrl: scratchUrl,
            migrationsFolder,
            ebs: { type: "disabled" },
          });
        } finally {
          await connection.release();
        }
        await run(database, await readRolePrivilegeCensus(database));
      });
    },
  );
};

describePostgres("database role privilege census", () => {
  // timeout: initializing PostgreSQL and applying the complete migration chain is the behavior under test.
  test("matches every migrated role and effective privilege", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (_database, actual) => {
      try {
        assertCompleteCensus(expected, actual);
      } catch (error) {
        throw new Error(
          'Database role privilege census is stale. Run `PATH="/usr/lib/postgresql/18/bin:$PATH" bun apps/api/scripts/update-role-privilege-census.ts` and review the changes.',
          { cause: error },
        );
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports disabled row-level security", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      try {
        await database.unsafe(
          `ALTER TABLE public.account_audit_logs DISABLE ROW LEVEL SECURITY`,
        );
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          "stella table:public.account_audit_logs:RLS_ENABLED:false",
        );
      } finally {
        await database.unsafe(
          `ALTER TABLE public.account_audit_logs ENABLE ROW LEVEL SECURITY`,
        );
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports a sequence UPDATE grant", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      const role = `stella_census_fixture_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      try {
        await database.unsafe(
          `CREATE ROLE "${role}" NOLOGIN; GRANT UPDATE ON SEQUENCE public.corpus_index_projection_revisions_revision_seq TO "${role}"`,
        );
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          `${role} sequence:public.corpus_index_projection_revisions_revision_seq:UPDATE:GRANTABLE:false`,
        );
      } finally {
        await database.unsafe(
          `DROP OWNED BY "${role}"; DROP ROLE IF EXISTS "${role}"`,
        );
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports a role granted CREATEDB", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      const role = `stella_census_fixture_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      try {
        await database.unsafe(`CREATE ROLE "${role}" CREATEDB NOLOGIN`);
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          `${role} attribute:CREATEDB:true`,
        );
      } finally {
        await database.unsafe(`DROP ROLE IF EXISTS "${role}"`);
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports a role granted REPLICATION", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      const role = `stella_census_fixture_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      try {
        await database.unsafe(`CREATE ROLE "${role}" REPLICATION NOLOGIN`);
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          `${role} attribute:REPLICATION:true`,
        );
      } finally {
        await database.unsafe(`DROP ROLE IF EXISTS "${role}"`);
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports a membership changed to WITH ADMIN OPTION", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const parent = `stella_census_parent_${suffix}`;
      const member = `stella_census_member_${suffix}`;
      try {
        await database.unsafe(`
          CREATE ROLE "${parent}" NOLOGIN;
          CREATE ROLE "${member}" NOLOGIN;
          GRANT "${parent}" TO "${member}";
        `);
        const withoutAdminOption = await readRolePrivilegeCensus(database);
        await database.unsafe(
          `GRANT "${parent}" TO "${member}" WITH ADMIN OPTION`,
        );
        const withAdminOption = await readRolePrivilegeCensus(database);
        expect(() =>
          assertCompleteCensus(withoutAdminOption, withAdminOption),
        ).toThrow(
          `${member} membership:${parent}:ADMIN_OPTION:true:INHERIT_OPTION:true:SET_OPTION:true`,
        );
      } finally {
        await database.unsafe(`
          REVOKE "${parent}" FROM "${member}";
          DROP ROLE IF EXISTS "${member}";
          DROP ROLE IF EXISTS "${parent}";
        `);
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports a column-level grant", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      const role = `stella_census_fixture_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      try {
        await database.unsafe(
          `CREATE ROLE "${role}" NOLOGIN; GRANT SELECT (id) ON TABLE public.account TO "${role}"`,
        );
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          `${role} column:public.account.id:SELECT:GRANTABLE:false`,
        );
      } finally {
        await database.unsafe(
          `DROP OWNED BY "${role}"; DROP ROLE IF EXISTS "${role}"`,
        );
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports an aggregate EXECUTE grant", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const role = `stella_census_fixture_${suffix}`;
      const aggregate = `stella_census_fixture_${suffix}`;
      try {
        await database.unsafe(`
          CREATE ROLE "${role}" NOLOGIN;
          CREATE AGGREGATE public."${aggregate}" (integer) (
            SFUNC = pg_catalog.int4pl,
            STYPE = integer,
            INITCOND = '0'
          );
          REVOKE ALL ON FUNCTION public."${aggregate}"(integer) FROM PUBLIC;
          GRANT EXECUTE ON FUNCTION public."${aggregate}"(integer) TO "${role}"
        `);
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          `${role} function:public.${aggregate}(integer):EXECUTE:GRANTABLE:false`,
        );
      } finally {
        await database.unsafe(`
          DROP AGGREGATE IF EXISTS public."${aggregate}"(integer);
          DROP OWNED BY "${role}";
          DROP ROLE IF EXISTS "${role}"
        `);
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports policies for a column-only grantee", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const role = `stella_census_fixture_${suffix}`;
      const table = `stella_census_fixture_${suffix}`;
      const policy = `stella_census_fixture_${suffix}`;
      try {
        await database.unsafe(`
          CREATE ROLE "${role}" NOLOGIN;
          CREATE TABLE public."${table}" (id integer PRIMARY KEY);
          ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY;
          CREATE POLICY "${policy}" ON public."${table}" FOR SELECT TO "${role}" USING (true);
          GRANT SELECT (id) ON TABLE public."${table}" TO "${role}"
        `);
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          `${role} table:public.${table}:POLICY:${policy}`,
        );
      } finally {
        await database.unsafe(`
          DROP TABLE IF EXISTS public."${table}";
          DROP OWNED BY "${role}";
          DROP ROLE IF EXISTS "${role}"
        `);
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports a new row-level security policy", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      const policy = `stella_census_fixture_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      try {
        await database.unsafe(
          `CREATE POLICY "${policy}" ON public.account_audit_logs AS PERMISSIVE FOR SELECT TO stella USING (false)`,
        );
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          `stella table:public.account_audit_logs:POLICY:${policy}`,
        );
      } finally {
        await database.unsafe(
          `DROP POLICY IF EXISTS "${policy}" ON public.account_audit_logs`,
        );
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports a changed row-level security USING predicate", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      try {
        await database.unsafe(
          `ALTER POLICY account_audit_logs_select ON public.account_audit_logs USING (true)`,
        );
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          "POLICY:account_audit_logs_select:COMMAND:SELECT:ROLES:public:PERMISSIVE:PERMISSIVE:USING:true:WITH_CHECK:NULL",
        );
      } finally {
        await database.unsafe(
          `ALTER POLICY account_audit_logs_select ON public.account_audit_logs USING (user_id = (SELECT current_setting('app.user_id', true)))`,
        );
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports a changed row-level security WITH CHECK predicate", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      try {
        await database.unsafe(
          `ALTER POLICY account_audit_logs_insert ON public.account_audit_logs WITH CHECK (true)`,
        );
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          "POLICY:account_audit_logs_insert:COMMAND:INSERT:ROLES:stella:PERMISSIVE:PERMISSIVE:USING:NULL:WITH_CHECK:true",
        );
      } finally {
        await database.unsafe(
          `ALTER POLICY account_audit_logs_insert ON public.account_audit_logs WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)))`,
        );
      }
    });
  }, 120_000);
});
