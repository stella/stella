import { panic } from "better-result";
import type { SQL, TransactionSQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { getPgErrorCode } from "@/api/lib/pg-error";
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

let censusDatabase: SQL | undefined;
let fixture: Promise<unknown> | undefined;
const fixtureReady = Promise.withResolvers<undefined>();
const releaseFixture = Promise.withResolvers<undefined>();
class CensusRollbackError extends Error {
  override name = "CensusRollbackError";
}

// timeout: applying the complete migration chain provisions the shared census fixture.
beforeAll(async () => {
  if (!runPostgresTests) {
    return;
  }
  fixture = withIsolatedPostgresCluster(
    {
      prefix: "role-census",
      database: "stella",
      user: "census_admin",
      password: "fixture",
    },
    async (scratchUrl) => {
      await withGatedTestClients(scratchUrl, async ({ openClient }) => {
        const migratedDatabase = openClient().sql;
        const connection = await migratedDatabase.reserve();
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
        censusDatabase = migratedDatabase;
        fixtureReady.resolve();
        await releaseFixture.promise;
      });
    },
  );
  void fixture.catch(fixtureReady.reject);
  await fixtureReady.promise;
}, 120_000);

afterAll(async () => {
  if (!runPostgresTests) {
    return;
  }
  releaseFixture.resolve(undefined);
  await fixture;
});

const withMigratedDatabase = async (
  run: (transaction: TransactionSQL, census: Census) => Promise<void>,
) => {
  const migratedDatabase =
    censusDatabase ?? panic("Census database is not ready");
  await migratedDatabase
    .begin(async (transaction) => {
      await run(transaction, await readRolePrivilegeCensus(transaction));
      throw new CensusRollbackError();
    })
    .catch((error: unknown) => {
      if (!(error instanceof CensusRollbackError)) {
        throw error;
      }
    });
};

describePostgres("database role privilege census", () => {
  const privilegesFor = (census: Census, role: string) =>
    census.roles.find((entry) => entry.role === role)?.privileges ??
    panic(`Role ${role} is missing from the privilege census`);

  // timeout: exhaustive privilege census queries can exceed the default test budget.
  test("matches every migrated role and effective privilege", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, actual) => {
      try {
        assertCompleteCensus(expected, actual);
      } catch (error) {
        throw new Error(
          'Database role privilege census is stale. Run `PATH="/usr/lib/postgresql/18/bin:$PATH" bun apps/api/scripts/update-role-privilege-census.ts` and review the changes.',
          { cause: error },
        );
      }
      expect(
        await database.unsafe(`SELECT
        has_function_privilege('stella', 'public.stella_chat_run_text_boundaries()', 'EXECUTE') AS runtime,
        has_function_privilege('stella_public_law_reader', 'public.stella_chat_run_text_boundaries()', 'EXECUTE') AS reader`),
      ).toEqual([{ runtime: true, reader: false }]);
      const denied = await rejectionOf(
        database.savepoint(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE stella_public_law_reader");
          await tx.unsafe("SELECT public.stella_chat_run_text_boundaries()");
        }),
      );
      expect(getPgErrorCode(denied)).toBe("42501");
    });
  }, 120_000);

  // timeout: exhaustive privilege census queries can exceed the default test budget.
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

  // timeout: exhaustive privilege census queries can exceed the default test budget.
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
          `${role} sequence:public.corpus_index_projection_revisions_revision_seq:UPDATE:EFFECTIVE`,
        );
      } finally {
        await database.unsafe(
          `DROP OWNED BY "${role}"; DROP ROLE IF EXISTS "${role}"`,
        );
      }
    });
  }, 120_000);

  // timeout: exhaustive privilege census queries can exceed the default test budget.
  test("reports a database CREATE grant to an existing restricted role", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      try {
        await database.unsafe(
          `GRANT CREATE ON DATABASE stella TO stella_public_law_reader`,
        );
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          "stella_public_law_reader database:stella:CREATE:EFFECTIVE",
        );
      } finally {
        await database.unsafe(
          `REVOKE CREATE ON DATABASE stella FROM stella_public_law_reader`,
        );
      }
    });
  }, 120_000);

  // timeout: exhaustive privilege census queries can exceed the default test budget.
  test("reports a changed grantor for a PUBLIC grant", async () => {
    await withMigratedDatabase(async (database) => {
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const firstGrantor = `stella_census_grantor_a_${suffix}`;
      const secondGrantor = `stella_census_grantor_b_${suffix}`;
      const table = `stella_census_fixture_${suffix}`;
      await database.unsafe(`
        CREATE ROLE "${firstGrantor}" NOLOGIN;
        CREATE ROLE "${secondGrantor}" NOLOGIN;
        CREATE TABLE public."${table}" (id integer);
        REVOKE ALL ON TABLE public."${table}" FROM PUBLIC;
        GRANT SELECT ON TABLE public."${table}" TO "${firstGrantor}", "${secondGrantor}" WITH GRANT OPTION;
        SET LOCAL SESSION AUTHORIZATION "${firstGrantor}";
        GRANT SELECT ON TABLE public."${table}" TO PUBLIC;
        RESET SESSION AUTHORIZATION;
      `);
      const firstCensus = await readRolePrivilegeCensus(database);
      expect(privilegesFor(firstCensus, "PUBLIC")).toContain(
        `table:public.${table}:SELECT:GRANTOR:${firstGrantor}:GRANTABLE:false`,
      );

      await database.unsafe(`
        SET LOCAL SESSION AUTHORIZATION "${firstGrantor}";
        REVOKE SELECT ON TABLE public."${table}" FROM PUBLIC;
        RESET SESSION AUTHORIZATION;
        SET LOCAL SESSION AUTHORIZATION "${secondGrantor}";
        GRANT SELECT ON TABLE public."${table}" TO PUBLIC;
        RESET SESSION AUTHORIZATION;
      `);
      const secondCensus = await readRolePrivilegeCensus(database);
      expect(privilegesFor(secondCensus, "PUBLIC")).toContain(
        `table:public.${table}:SELECT:GRANTOR:${secondGrantor}:GRANTABLE:false`,
      );
      expect(() => assertCompleteCensus(firstCensus, secondCensus)).toThrow(
        `PUBLIC table:public.${table}:SELECT:GRANTOR:${secondGrantor}:GRANTABLE:false`,
      );
    });
  }, 120_000);

  // timeout: exhaustive privilege census queries can exceed the default test budget.
  test("does not inherit privileges through a membership that disables INHERIT and SET", async () => {
    await withMigratedDatabase(async (database) => {
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const parent = `stella_census_parent_${suffix}`;
      const member = `stella_census_member_${suffix}`;
      const effective = "table:public.account:SELECT:EFFECTIVE";
      try {
        await database.unsafe(`
          CREATE ROLE "${parent}" NOLOGIN;
          CREATE ROLE "${member}" NOLOGIN;
          GRANT SELECT ON TABLE public.account TO "${parent}", "${member}";
          GRANT "${parent}" TO "${member}" WITH INHERIT FALSE, SET FALSE;
        `);
        const beforeRevoke = await readRolePrivilegeCensus(database);
        expect(privilegesFor(beforeRevoke, member)).toContain(effective);

        await database.unsafe(
          `REVOKE SELECT ON TABLE public.account FROM "${member}"`,
        );
        const afterRevoke = await readRolePrivilegeCensus(database);
        expect(privilegesFor(afterRevoke, member)).not.toContain(effective);
        expect(() => assertCompleteCensus(beforeRevoke, afterRevoke)).toThrow(
          `${member} ${effective}`,
        );
      } finally {
        await database.unsafe(`
          REVOKE "${parent}" FROM "${member}";
          DROP OWNED BY "${member}";
          DROP OWNED BY "${parent}";
          DROP ROLE IF EXISTS "${member}";
          DROP ROLE IF EXISTS "${parent}";
        `);
      }
    });
  }, 120_000);

  // timeout: exhaustive privilege census queries can exceed the default test budget.
  test("inherits privileges through a membership that enables INHERIT", async () => {
    await withMigratedDatabase(async (database) => {
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const parent = `stella_census_parent_${suffix}`;
      const member = `stella_census_member_${suffix}`;
      const effective = "table:public.account:SELECT:EFFECTIVE";
      try {
        await database.unsafe(`
          CREATE ROLE "${parent}" NOLOGIN;
          CREATE ROLE "${member}" NOLOGIN;
          GRANT SELECT ON TABLE public.account TO "${parent}", "${member}";
          GRANT "${parent}" TO "${member}" WITH INHERIT TRUE, SET FALSE;
        `);
        await database.unsafe(
          `REVOKE SELECT ON TABLE public.account FROM "${member}"`,
        );
        const afterRevoke = await readRolePrivilegeCensus(database);
        expect(privilegesFor(afterRevoke, member)).toContain(effective);
      } finally {
        await database.unsafe(`
          REVOKE "${parent}" FROM "${member}";
          DROP OWNED BY "${member}";
          DROP OWNED BY "${parent}";
          DROP ROLE IF EXISTS "${member}";
          DROP ROLE IF EXISTS "${parent}";
        `);
      }
    });
  }, 120_000);

  // timeout: exhaustive privilege census queries can exceed the default test budget.
  test("reports predefined-role privileges without an object ACL", async () => {
    await withMigratedDatabase(async (database) => {
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const owner = `stella_census_owner_${suffix}`;
      const reader = `stella_census_reader_${suffix}`;
      const table = `stella_census_fixture_${suffix}`;
      try {
        await database.unsafe(`
          CREATE ROLE "${owner}" NOLOGIN;
          CREATE ROLE "${reader}" NOLOGIN;
          CREATE TABLE public."${table}" (id integer);
          ALTER TABLE public."${table}" OWNER TO "${owner}";
          REVOKE SELECT ON TABLE public."${table}" FROM "${owner}", PUBLIC;
          GRANT pg_read_all_data TO "${reader}";
        `);
        const acl = await database.unsafe<{ hasSelectAcl: boolean }[]>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_catalog.pg_class class
            CROSS JOIN LATERAL pg_catalog.aclexplode(class.relacl) acl
            WHERE class.oid = 'public."${table}"'::regclass
              AND acl.privilege_type = 'SELECT'
          ) AS "hasSelectAcl"
        `);
        expect(acl.at(0)?.hasSelectAcl).toBeFalse();

        const census = await readRolePrivilegeCensus(database);
        expect(privilegesFor(census, reader)).toContain(
          `table:public.${table}:SELECT:EFFECTIVE`,
        );
      } finally {
        await database.unsafe(`
          DROP TABLE IF EXISTS public."${table}";
          REVOKE pg_read_all_data FROM "${reader}";
          DROP OWNED BY "${reader}";
          DROP OWNED BY "${owner}";
          DROP ROLE IF EXISTS "${reader}";
          DROP ROLE IF EXISTS "${owner}";
        `);
      }
    });
  }, 120_000);

  // timeout: exhaustive privilege census queries can exceed the default test budget.
  test("reports inherited grant options from roles outside the audited set", async () => {
    await withMigratedDatabase(async (database) => {
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const parent = `external_census_parent_${suffix}`;
      const member = `stella_census_member_${suffix}`;
      const grantable = "table:public.account:SELECT:EFFECTIVE_GRANTABLE";
      const censusAsParent = async () =>
        database.savepoint(async (transaction) => {
          await transaction.unsafe(
            `SET LOCAL SESSION AUTHORIZATION "${parent}"`,
          );
          const census = await readRolePrivilegeCensus(transaction);
          await transaction.unsafe("RESET SESSION AUTHORIZATION");
          return census;
        });
      try {
        await database.unsafe(`
          CREATE ROLE "${parent}" NOLOGIN;
          CREATE ROLE "${member}" NOLOGIN;
          GRANT SELECT ON TABLE public.account TO "${parent}";
          GRANT "${parent}" TO "${member}" WITH INHERIT TRUE, SET FALSE;
        `);
        const withoutGrantOption = await censusAsParent();
        expect(privilegesFor(withoutGrantOption, member)).not.toContain(
          grantable,
        );

        await database.unsafe(
          `GRANT SELECT ON TABLE public.account TO "${parent}" WITH GRANT OPTION`,
        );
        const withGrantOption = await censusAsParent();
        expect(privilegesFor(withGrantOption, member)).toContain(grantable);
        expect(() =>
          assertCompleteCensus(withoutGrantOption, withGrantOption),
        ).toThrow(`${member} ${grantable}`);
      } finally {
        await database.unsafe(`
          REVOKE "${parent}" FROM "${member}";
          DROP OWNED BY "${member}";
          DROP OWNED BY "${parent}";
          DROP ROLE IF EXISTS "${member}";
          DROP ROLE IF EXISTS "${parent}";
        `);
      }
    });
  }, 120_000);

  // timeout: exhaustive privilege census queries can exceed the default test budget.
  test("records SET-only privileges separately from effective privileges", async () => {
    await withMigratedDatabase(async (database) => {
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const parent = `stella_census_parent_${suffix}`;
      const member = `stella_census_member_${suffix}`;
      try {
        await database.unsafe(`
          CREATE ROLE "${parent}" NOLOGIN;
          CREATE ROLE "${member}" NOLOGIN;
          GRANT SELECT ON TABLE public.account TO "${parent}";
          GRANT "${parent}" TO "${member}" WITH INHERIT FALSE, SET TRUE;
        `);
        const census = await readRolePrivilegeCensus(database);
        expect(privilegesFor(census, member)).toContain(
          "table:public.account:SELECT:SET_REACHABLE",
        );
        expect(privilegesFor(census, member)).not.toContain(
          "table:public.account:SELECT:EFFECTIVE",
        );
      } finally {
        await database.unsafe(`
          REVOKE "${parent}" FROM "${member}";
          DROP OWNED BY "${member}";
          DROP OWNED BY "${parent}";
          DROP ROLE IF EXISTS "${member}";
          DROP ROLE IF EXISTS "${parent}";
        `);
      }
    });
  }, 120_000);

  // timeout: exhaustive privilege census queries can exceed the default test budget.
  test("records SET-only privileges through roles outside the audited set", async () => {
    await withMigratedDatabase(async (database) => {
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const parent = `external_census_parent_${suffix}`;
      const member = `stella_census_member_${suffix}`;
      const setReachable = "table:public.account:SELECT:SET_REACHABLE";
      const censusAsParent = async () =>
        database.savepoint(async (transaction) => {
          await transaction.unsafe(
            `SET LOCAL SESSION AUTHORIZATION "${parent}"`,
          );
          const census = await readRolePrivilegeCensus(transaction);
          await transaction.unsafe("RESET SESSION AUTHORIZATION");
          return census;
        });
      try {
        await database.unsafe(`
          CREATE ROLE "${parent}" NOLOGIN;
          CREATE ROLE "${member}" NOLOGIN;
          GRANT SELECT ON TABLE public.account TO "${parent}";
          GRANT "${parent}" TO "${member}" WITH INHERIT FALSE, SET TRUE;
        `);
        const withSet = await censusAsParent();
        expect(
          withSet.roles.some((entry) => entry.role === parent),
        ).toBeFalse();
        expect(privilegesFor(withSet, member)).toContain(setReachable);

        await database.unsafe(
          `GRANT "${parent}" TO "${member}" WITH INHERIT FALSE, SET FALSE`,
        );
        const withoutSet = await censusAsParent();
        expect(privilegesFor(withoutSet, member)).not.toContain(setReachable);
      } finally {
        await database.unsafe(`
          REVOKE "${parent}" FROM "${member}";
          DROP OWNED BY "${member}";
          DROP OWNED BY "${parent}";
          DROP ROLE IF EXISTS "${member}";
          DROP ROLE IF EXISTS "${parent}";
        `);
      }
    });
  }, 120_000);

  // timeout: exhaustive privilege census queries can exceed the default test budget.
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

  // timeout: exhaustive privilege census queries can exceed the default test budget.
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

  // timeout: exhaustive privilege census queries can exceed the default test budget.
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

  // timeout: exhaustive privilege census queries can exceed the default test budget.
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
          `${role} column:public.account.id:SELECT:EFFECTIVE`,
        );
      } finally {
        await database.unsafe(
          `DROP OWNED BY "${role}"; DROP ROLE IF EXISTS "${role}"`,
        );
      }
    });
  }, 120_000);

  // timeout: exhaustive privilege census queries can exceed the default test budget.
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
          `${role} function:public.${aggregate}(integer):EXECUTE:EFFECTIVE`,
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

  // timeout: exhaustive privilege census queries can exceed the default test budget.
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

  // timeout: exhaustive privilege census queries can exceed the default test budget.
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

  // timeout: exhaustive privilege census queries can exceed the default test budget.
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

  // timeout: exhaustive privilege census queries can exceed the default test budget.
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
