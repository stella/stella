import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { INVOICE_SEND_UPDATE_COLUMNS } from "@/api/db/schema";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { withIsolatedPostgresCluster } from "@/api/tests/isolated-postgres-cluster";

import { runMigrations } from "../../db/migration-runner";

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const describePostgres = describe.skipIf(!runPostgresTests);
const migrationsFolder = path.resolve(import.meta.dir, "../../../drizzle");
const censusPath = path.join(import.meta.dir, "role-privilege-census.json");

type RoleCensus = {
  role: string;
  attributes: string[];
  memberships: string[];
  privileges: string[];
};

type CensusRow = {
  role: string;
  kind: "attribute" | "membership" | "privilege";
  value: string;
};

const readRolePrivilegeCensus = async (
  database: SQL,
): Promise<RoleCensus[]> => {
  const rows = await database.unsafe<CensusRow[]>(`
    WITH RECURSIVE
    application_roles AS (
      SELECT oid, rolname, rolsuper, rolcreaterole, rolcanlogin, rolbypassrls
      FROM pg_catalog.pg_roles
      WHERE rolname !~ '^pg_' AND rolname <> current_user
    ),
    memberships(member, parent) AS (
      SELECT member, roleid FROM pg_catalog.pg_auth_members
      UNION
      SELECT memberships.member, auth.roleid
      FROM memberships
      JOIN pg_catalog.pg_auth_members auth ON auth.member = memberships.parent
    ),
    application_schemas AS (
      SELECT oid, nspname
      FROM pg_catalog.pg_namespace
      WHERE nspname <> 'information_schema'
        AND nspname <> 'drizzle'
        AND nspname !~ '^pg_'
    ),
    application_relations AS (
      SELECT class.oid, namespace.nspname, class.relname, class.relkind,
             class.relforcerowsecurity
      FROM pg_catalog.pg_class class
      JOIN application_schemas namespace ON namespace.oid = class.relnamespace
      WHERE class.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    ),
    table_privileges(privilege) AS (
      VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
             ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')
    ),
    results AS (
      SELECT role.rolname AS role, 'attribute'::text AS kind,
             attribute.name || ':' || attribute.enabled AS value
      FROM application_roles role
      CROSS JOIN LATERAL (VALUES
        ('BYPASSRLS', role.rolbypassrls::text),
        ('CREATEROLE', role.rolcreaterole::text),
        ('LOGIN', role.rolcanlogin::text),
        ('SUPERUSER', role.rolsuper::text)
      ) attribute(name, enabled)
      UNION ALL
      SELECT member.rolname, 'membership', parent.rolname
      FROM memberships membership
      JOIN application_roles member ON member.oid = membership.member
      JOIN pg_catalog.pg_roles parent ON parent.oid = membership.parent
      UNION ALL
      SELECT role.rolname, 'privilege',
             'schema:' || schema.nspname || ':' || privilege.name
      FROM application_roles role
      CROSS JOIN application_schemas schema
      CROSS JOIN (VALUES ('USAGE'), ('CREATE')) privilege(name)
      WHERE pg_catalog.has_schema_privilege(role.oid, schema.oid, privilege.name)
      UNION ALL
      SELECT role.rolname, 'privilege',
             'table:' || relation.nspname || '.' || relation.relname || ':' || privilege.privilege
      FROM application_roles role
      CROSS JOIN application_relations relation
      CROSS JOIN table_privileges privilege
      WHERE relation.relkind <> 'S'
        AND pg_catalog.has_table_privilege(role.oid, relation.oid, privilege.privilege)
      UNION ALL
      SELECT role.rolname, 'privilege',
             'table:' || relation.nspname || '.' || relation.relname || ':RLS_FORCED:' || relation.relforcerowsecurity
      FROM application_roles role
      CROSS JOIN application_relations relation
      WHERE relation.relkind <> 'S'
        AND (pg_catalog.has_table_privilege(role.oid, relation.oid, 'INSERT')
          OR pg_catalog.has_table_privilege(role.oid, relation.oid, 'UPDATE')
          OR pg_catalog.has_table_privilege(role.oid, relation.oid, 'DELETE'))
      UNION ALL
      SELECT role.rolname, 'privilege',
             'sequence:' || relation.nspname || '.' || relation.relname || ':USAGE'
      FROM application_roles role
      CROSS JOIN application_relations relation
      WHERE relation.relkind = 'S'
        AND pg_catalog.has_sequence_privilege(role.oid, relation.oid, 'USAGE')
      UNION ALL
      SELECT role.rolname, 'privilege',
             'function:' || namespace.nspname || '.' || procedure.proname ||
             '(' || pg_catalog.pg_get_function_identity_arguments(procedure.oid) || '):EXECUTE'
      FROM application_roles role
      CROSS JOIN pg_catalog.pg_proc procedure
      JOIN application_schemas namespace ON namespace.oid = procedure.pronamespace
      WHERE pg_catalog.has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
    )
    SELECT role, kind, value FROM results ORDER BY role, kind, value
  `);

  const census = new Map<string, RoleCensus>();
  for (const row of rows) {
    const entry = census.get(row.role) ?? {
      role: row.role,
      attributes: [],
      memberships: [],
      privileges: [],
    };
    switch (row.kind) {
      case "attribute":
        entry.attributes.push(row.value);
        break;
      case "membership":
        entry.memberships.push(row.value);
        break;
      case "privilege":
        entry.privileges.push(row.value);
        break;
      default:
        row.kind satisfies never;
    }
    census.set(row.role, entry);
  }
  return [...census.values()];
};

const censusLines = (census: RoleCensus[]) =>
  census.flatMap(({ role, attributes, memberships, privileges }) => [
    `${role} role`,
    ...attributes.map((attribute) => `${role} attribute:${attribute}`),
    ...memberships.map((membership) => `${role} membership:${membership}`),
    ...privileges.map((privilege) => `${role} ${privilege}`),
  ]);

const assertCensus = (expected: RoleCensus[], actual: RoleCensus[]) => {
  const expectedLines = new Set(censusLines(expected));
  const actualLines = new Set(censusLines(actual));
  const removed = [...expectedLines]
    .filter((line) => !actualLines.has(line))
    .map((line) => `- ${line}`);
  const added = [...actualLines]
    .filter((line) => !expectedLines.has(line))
    .map((line) => `+ ${line}`);
  if (removed.length > 0 || added.length > 0) {
    throw new Error(
      `Database role privilege census changed:\n${[...removed, ...added].join("\n")}`,
    );
  }
};

const withMigratedDatabase = async (
  run: (database: SQL, census: RoleCensus[]) => Promise<void>,
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
    const expected = JSON.parse(readFileSync(censusPath, "utf-8"));
    await withMigratedDatabase(async (database, actual) => {
      assertCensus(expected, actual);
      // Column grants intentionally do not count as a table-wide UPDATE.
      const invoiceSendColumns = await database.unsafe(`
        SELECT attribute.attname AS column
        FROM pg_catalog.pg_attribute attribute
        WHERE attribute.attrelid = 'public.invoice_sends'::regclass
          AND attribute.attnum > 0 AND NOT attribute.attisdropped
          AND pg_catalog.has_column_privilege('stella', attribute.attrelid, attribute.attnum, 'UPDATE')
        ORDER BY attribute.attname
      `);
      expect(invoiceSendColumns).toEqual(
        INVOICE_SEND_UPDATE_COLUMNS.map(({ name }) => name)
          .toSorted()
          .map((column) => ({ column })),
      );
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports a fixture migration's additional role privilege", async () => {
    const expected = JSON.parse(readFileSync(censusPath, "utf-8"));
    await withMigratedDatabase(async (database, baseline) => {
      assertCensus(expected, baseline);
      const role = `stella_census_fixture_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      try {
        await database.unsafe(
          `CREATE ROLE "${role}" NOLOGIN; GRANT SELECT ON TABLE public.account TO "${role}"`,
        );
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCensus(expected, mutated)).toThrow(
          `${role} table:public.account:SELECT`,
        );
      } finally {
        await database.unsafe(
          `DROP OWNED BY "${role}"; DROP ROLE IF EXISTS "${role}"`,
        );
      }
    });
  }, 120_000);
});
