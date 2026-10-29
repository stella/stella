import { panic } from "better-result";
import type { SQL } from "bun";
import { writeFileSync } from "node:fs";
import path from "node:path";

import policyCensus from "./role-policy-census.json" with { type: "json" };
import roleCensus from "./role-privilege-census.json" with { type: "json" };

const censusPath = path.join(import.meta.dir, "role-privilege-census.json");
const policyCensusPath = path.join(import.meta.dir, "role-policy-census.json");

export type RoleCensus = {
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

export type PolicyCensus = {
  schema: string;
  table: string;
  policy: string;
  command: string;
  roles: string[];
  permissive: string;
  using: string | null;
  withCheck: string | null;
};

export type Census = {
  roles: RoleCensus[];
  policies: PolicyCensus[];
};

export const readRolePrivilegeCensus = async (
  database: SQL,
): Promise<Census> => {
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
      SELECT oid, nspname, nspowner, nspacl
      FROM pg_catalog.pg_namespace
      WHERE nspname <> 'information_schema'
        AND nspname <> 'drizzle'
        AND nspname !~ '^pg_'
    ),
    application_relations AS (
      SELECT class.oid, class.relowner, class.relacl, namespace.nspname,
             class.relname, class.relkind, class.relrowsecurity,
             class.relforcerowsecurity
      FROM pg_catalog.pg_class class
      JOIN application_schemas namespace ON namespace.oid = class.relnamespace
      WHERE class.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    ),
    effective_grantees(role_oid, grant_oid) AS (
      SELECT oid, oid FROM application_roles
      UNION ALL
      SELECT oid, 0::oid FROM application_roles
      UNION
      SELECT memberships.member, memberships.parent FROM memberships
    ),
    object_acl(kind, object_name, owner_oid, acl) AS (
      SELECT CASE WHEN relation.relkind = 'S' THEN 'sequence' ELSE 'table' END,
             relation.nspname || '.' || relation.relname, relation.relowner,
             COALESCE(relation.relacl, pg_catalog.acldefault(
               CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END,
               relation.relowner
             ))
      FROM application_relations relation
      UNION ALL
      SELECT 'column', relation.nspname || '.' || relation.relname || '.' || attribute.attname,
             relation.relowner, attribute.attacl
      FROM application_relations relation
      JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid
      WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
        AND attribute.attacl IS NOT NULL
      UNION ALL
      SELECT 'function', namespace.nspname || '.' || procedure.proname ||
             '(' || pg_catalog.pg_get_function_identity_arguments(procedure.oid) || ')',
             procedure.proowner,
             COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
      FROM pg_catalog.pg_proc procedure
      JOIN application_schemas namespace ON namespace.oid = procedure.pronamespace
      WHERE procedure.prokind IN ('f', 'a', 'w')
      UNION ALL
      SELECT 'procedure', namespace.nspname || '.' || procedure.proname ||
             '(' || pg_catalog.pg_get_function_identity_arguments(procedure.oid) || ')',
             procedure.proowner,
             COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
      FROM pg_catalog.pg_proc procedure
      JOIN application_schemas namespace ON namespace.oid = procedure.pronamespace
      WHERE procedure.prokind = 'p'
      UNION ALL
      SELECT 'schema', schema.nspname, schema.nspowner,
             COALESCE(schema.nspacl, pg_catalog.acldefault('n', schema.nspowner))
      FROM application_schemas schema
      UNION ALL
      SELECT CASE WHEN type.typtype = 'd' THEN 'domain' ELSE 'type' END,
             namespace.nspname || '.' || type.typname, type.typowner,
             COALESCE(type.typacl, pg_catalog.acldefault('T', type.typowner))
      FROM pg_catalog.pg_type type
      JOIN application_schemas namespace ON namespace.oid = type.typnamespace
      UNION ALL
      SELECT 'large_object', metadata.oid::text, metadata.lomowner,
             COALESCE(metadata.lomacl, pg_catalog.acldefault('L', metadata.lomowner))
      FROM pg_catalog.pg_largeobject_metadata metadata
    ),
    expanded_acl AS (
      SELECT object_acl.kind, object_acl.object_name,
             acl.grantee, acl.privilege_type, acl.is_grantable
      FROM object_acl
      CROSS JOIN LATERAL pg_catalog.aclexplode(object_acl.acl) acl
    ),
    effective_acl AS (
      SELECT grantee.role_oid, acl.kind, acl.object_name, acl.privilege_type,
             bool_or(acl.is_grantable) AS is_grantable
      FROM expanded_acl acl
      JOIN effective_grantees grantee ON grantee.grant_oid = acl.grantee
      GROUP BY grantee.role_oid, acl.kind, acl.object_name, acl.privilege_type
    ),
    relation_roles AS (
      SELECT DISTINCT acl.role_oid, relation.oid
      FROM effective_acl acl
      JOIN application_relations relation
        ON (
          acl.kind IN ('table', 'sequence')
          AND acl.object_name = relation.nspname || '.' || relation.relname
        ) OR (
          acl.kind = 'column'
          AND left(acl.object_name, length(relation.nspname || '.' || relation.relname) + 1) =
              relation.nspname || '.' || relation.relname || '.'
        )
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
      SELECT role.rolname, 'privilege', acl.kind || ':' || acl.object_name || ':' ||
             acl.privilege_type || ':GRANTABLE:' || acl.is_grantable
      FROM effective_acl acl
      JOIN application_roles role ON role.oid = acl.role_oid
      UNION ALL
      SELECT role.rolname, 'privilege',
             'table:' || relation.nspname || '.' || relation.relname ||
             ':RLS_ENABLED:' || relation.relrowsecurity
      FROM relation_roles accessible
      JOIN application_roles role ON role.oid = accessible.role_oid
      JOIN application_relations relation ON relation.oid = accessible.oid
      WHERE relation.relkind <> 'S'
      UNION ALL
      SELECT role.rolname, 'privilege',
             'table:' || relation.nspname || '.' || relation.relname ||
             ':RLS_FORCED:' || relation.relforcerowsecurity
      FROM relation_roles accessible
      JOIN application_roles role ON role.oid = accessible.role_oid
      JOIN application_relations relation ON relation.oid = accessible.oid
      WHERE relation.relkind <> 'S'
      UNION ALL
      SELECT role.rolname, 'privilege',
             'table:' || policy.schemaname || '.' || policy.tablename ||
             ':POLICY:' || policy.policyname
      FROM pg_catalog.pg_policies policy
      JOIN application_schemas schema ON schema.nspname = policy.schemaname
      JOIN application_relations relation
        ON relation.nspname = policy.schemaname AND relation.relname = policy.tablename
      JOIN relation_roles accessible ON accessible.oid = relation.oid
      JOIN application_roles role ON role.oid = accessible.role_oid
    )
    SELECT role, kind, value FROM results ORDER BY role, kind, value
  `);

  const policies = await database.unsafe<PolicyCensus[]>(`
    SELECT schemaname AS schema, tablename AS table, policyname AS policy,
           cmd AS command, roles, permissive,
           qual AS using, with_check AS "withCheck"
    FROM pg_catalog.pg_policies
    WHERE schemaname <> 'information_schema'
      AND schemaname <> 'drizzle'
      AND schemaname !~ '^pg_'
    ORDER BY schemaname, tablename, policyname
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
        return panic("Unexpected census row kind");
    }
    census.set(row.role, entry);
  }
  return { roles: [...census.values()], policies };
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
    panic(
      `Database role privilege census changed:\n${[...removed, ...added].join("\n")}`,
    );
  }
};

const policyLines = (policies: PolicyCensus[]) =>
  policies.map(
    (policy) =>
      `${policy.schema}.${policy.table}:POLICY:${policy.policy}:COMMAND:${policy.command}:ROLES:${policy.roles.join(",")}:PERMISSIVE:${policy.permissive}:USING:${policy.using ?? "NULL"}:WITH_CHECK:${policy.withCheck ?? "NULL"}`,
  );

const assertPolicyCensus = (
  expected: PolicyCensus[],
  actual: PolicyCensus[],
) => {
  const expectedLines = new Set(policyLines(expected));
  const actualLines = new Set(policyLines(actual));
  const removed = [...expectedLines]
    .filter((line) => !actualLines.has(line))
    .map((line) => `- ${line}`);
  const added = [...actualLines]
    .filter((line) => !expectedLines.has(line))
    .map((line) => `+ ${line}`);
  if (removed.length > 0 || added.length > 0) {
    panic(
      `Database row-level security policy census changed:\n${[...removed, ...added].join("\n")}`,
    );
  }
};

export const readExpectedCensus = (): Census => ({
  roles: roleCensus,
  policies: policyCensus,
});

export const assertCompleteCensus = (expected: Census, actual: Census) => {
  assertCensus(expected.roles, actual.roles);
  assertPolicyCensus(expected.policies, actual.policies);
};

const formatCensus = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export const writeRolePrivilegeCensus = (census: Census) => {
  writeFileSync(censusPath, formatCensus(census.roles));
  writeFileSync(policyCensusPath, formatCensus(census.policies));
};
