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
  /** Null for the PUBLIC pseudo-role, so no role name can pose as it. */
  role: string | null;
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

/**
 * PUBLIC's grants and effective privileges hold for every role, so they are
 * recorded once here and each role lists only what it holds beyond them.
 * Likewise a column privilege is listed only where the table privilege of
 * the same name does not already imply it.
 */
export type RolePrivilegeCensus = {
  public: string[];
  roles: RoleCensus[];
};

export type Census = RolePrivilegeCensus & {
  policies: PolicyCensus[];
};

/** A missing role fails loudly: absence never reads as "no privileges". */
export const rolePrivileges = (census: RolePrivilegeCensus, role: string) =>
  census.roles.find((entry) => entry.role === role)?.privileges ??
  panic(`Role ${role} is missing from the privilege census`);

const rolePrivilegeCensusQuery = `
    WITH
    application_roles AS (
      SELECT oid, rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolreplication, rolbypassrls
      FROM pg_catalog.pg_roles
      WHERE rolname !~ '^pg_' AND rolname <> current_user
    ),
    direct_memberships(member, parent, admin_option, inherit_option, set_option) AS (
      SELECT member, roleid, admin_option, inherit_option, set_option FROM pg_catalog.pg_auth_members
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
    object_acl(kind, object_name, object_oid, sub_id, owner_oid, acl) AS (
      SELECT CASE WHEN relation.relkind = 'S' THEN 'sequence' ELSE 'table' END,
             relation.nspname || '.' || relation.relname, relation.oid, 0,
             relation.relowner,
             COALESCE(relation.relacl, pg_catalog.acldefault(
               CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END,
               relation.relowner
             ))
      FROM application_relations relation
      UNION ALL
      SELECT 'column', relation.nspname || '.' || relation.relname || '.' || attribute.attname,
             relation.oid, attribute.attnum, relation.relowner, attribute.attacl
      FROM application_relations relation
      JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid
      WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
      UNION ALL
      SELECT 'function', namespace.nspname || '.' || procedure.proname ||
             '(' || pg_catalog.pg_get_function_identity_arguments(procedure.oid) || ')',
             procedure.oid, 0, procedure.proowner,
             COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
      FROM pg_catalog.pg_proc procedure
      JOIN application_schemas namespace ON namespace.oid = procedure.pronamespace
      WHERE procedure.prokind IN ('f', 'a', 'w')
      UNION ALL
      SELECT 'procedure', namespace.nspname || '.' || procedure.proname ||
             '(' || pg_catalog.pg_get_function_identity_arguments(procedure.oid) || ')',
             procedure.oid, 0, procedure.proowner,
             COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
      FROM pg_catalog.pg_proc procedure
      JOIN application_schemas namespace ON namespace.oid = procedure.pronamespace
      WHERE procedure.prokind = 'p'
      UNION ALL
      SELECT 'schema', schema.nspname, schema.oid, 0, schema.nspowner,
             COALESCE(schema.nspacl, pg_catalog.acldefault('n', schema.nspowner))
      FROM application_schemas schema
      UNION ALL
      SELECT CASE WHEN type.typtype = 'd' THEN 'domain' ELSE 'type' END,
             namespace.nspname || '.' || type.typname, type.oid, 0, type.typowner,
             COALESCE(type.typacl, pg_catalog.acldefault('T', type.typowner))
      FROM pg_catalog.pg_type type
      JOIN application_schemas namespace ON namespace.oid = type.typnamespace
      UNION ALL
      SELECT 'large_object', metadata.oid::text, metadata.oid, 0, metadata.lomowner,
             COALESCE(metadata.lomacl, pg_catalog.acldefault('L', metadata.lomowner))
      FROM pg_catalog.pg_largeobject_metadata metadata
      UNION ALL
      SELECT 'database', database.datname, database.oid, 0, database.datdba,
             COALESCE(database.datacl, pg_catalog.acldefault('d', database.datdba))
      FROM pg_catalog.pg_database database
      WHERE database.datname = current_database()
    ),
    expanded_acl AS (
      SELECT object_acl.kind, object_acl.object_name, object_acl.object_oid,
             object_acl.sub_id, acl.grantor, acl.grantee, acl.privilege_type,
             acl.is_grantable
      FROM object_acl
      CROSS JOIN LATERAL pg_catalog.aclexplode(object_acl.acl) acl
    ),
    privilege_candidates AS (
      SELECT object_acl.kind, object_acl.object_name, object_acl.object_oid,
             object_acl.sub_id, privilege.privilege_type
      FROM object_acl
      CROSS JOIN LATERAL (VALUES
        ('database', 'CONNECT'), ('database', 'CREATE'), ('database', 'TEMPORARY'),
        ('schema', 'CREATE'), ('schema', 'USAGE'),
        ('table', 'DELETE'), ('table', 'INSERT'), ('table', 'MAINTAIN'),
        ('table', 'REFERENCES'), ('table', 'SELECT'), ('table', 'TRIGGER'),
        ('table', 'TRUNCATE'), ('table', 'UPDATE'),
        ('column', 'INSERT'), ('column', 'REFERENCES'), ('column', 'SELECT'),
        ('column', 'UPDATE'),
        ('sequence', 'SELECT'), ('sequence', 'UPDATE'), ('sequence', 'USAGE'),
        ('function', 'EXECUTE'), ('procedure', 'EXECUTE'),
        ('domain', 'USAGE'), ('type', 'USAGE'),
        ('large_object', 'SELECT'), ('large_object', 'UPDATE')
      ) privilege(object_kind, privilege_type)
      WHERE privilege.object_kind = object_acl.kind
    ),
    -- Role OID 0 is PUBLIC in aclitem entries and in the has_*_privilege
    -- functions, so PUBLIC's effective privileges are read once and every
    -- role's privileges are recorded only where they go beyond them.
    audited_roles AS (
      SELECT oid FROM application_roles
      UNION ALL
      SELECT 0::oid
    ),
    role_privileges AS (
      SELECT role.oid AS role_oid, candidate.*,
             -- A table privilege implies the same privilege on each column.
             CASE WHEN candidate.kind = 'column'
               THEN pg_catalog.has_table_privilege(role.oid, candidate.object_oid, candidate.privilege_type)
               ELSE false
             END AS relation_effective,
             CASE WHEN candidate.kind = 'column'
               THEN pg_catalog.has_table_privilege(role.oid, candidate.object_oid, candidate.privilege_type || ' WITH GRANT OPTION')
               ELSE false
             END AS relation_grantable,
             CASE candidate.kind
               WHEN 'database' THEN pg_catalog.has_database_privilege(role.oid, candidate.object_oid, candidate.privilege_type)
               WHEN 'schema' THEN pg_catalog.has_schema_privilege(role.oid, candidate.object_oid, candidate.privilege_type)
               WHEN 'table' THEN pg_catalog.has_table_privilege(role.oid, candidate.object_oid, candidate.privilege_type)
               WHEN 'column' THEN pg_catalog.has_column_privilege(role.oid, candidate.object_oid, candidate.sub_id::smallint, candidate.privilege_type)
               WHEN 'sequence' THEN pg_catalog.has_sequence_privilege(role.oid, candidate.object_oid, candidate.privilege_type)
               WHEN 'function' THEN pg_catalog.has_function_privilege(role.oid, candidate.object_oid, candidate.privilege_type)
               WHEN 'procedure' THEN pg_catalog.has_function_privilege(role.oid, candidate.object_oid, candidate.privilege_type)
               WHEN 'domain' THEN pg_catalog.has_type_privilege(role.oid, candidate.object_oid, candidate.privilege_type)
               WHEN 'type' THEN pg_catalog.has_type_privilege(role.oid, candidate.object_oid, candidate.privilege_type)
               WHEN 'large_object' THEN pg_catalog.has_largeobject_privilege(role.oid, candidate.object_oid, candidate.privilege_type)
             END AS effective,
             CASE candidate.kind
               WHEN 'database' THEN pg_catalog.has_database_privilege(role.oid, candidate.object_oid, candidate.privilege_type || ' WITH GRANT OPTION')
               WHEN 'schema' THEN pg_catalog.has_schema_privilege(role.oid, candidate.object_oid, candidate.privilege_type || ' WITH GRANT OPTION')
               WHEN 'table' THEN pg_catalog.has_table_privilege(role.oid, candidate.object_oid, candidate.privilege_type || ' WITH GRANT OPTION')
               WHEN 'column' THEN pg_catalog.has_column_privilege(role.oid, candidate.object_oid, candidate.sub_id::smallint, candidate.privilege_type || ' WITH GRANT OPTION')
               WHEN 'sequence' THEN pg_catalog.has_sequence_privilege(role.oid, candidate.object_oid, candidate.privilege_type || ' WITH GRANT OPTION')
               WHEN 'function' THEN pg_catalog.has_function_privilege(role.oid, candidate.object_oid, candidate.privilege_type || ' WITH GRANT OPTION')
               WHEN 'procedure' THEN pg_catalog.has_function_privilege(role.oid, candidate.object_oid, candidate.privilege_type || ' WITH GRANT OPTION')
               WHEN 'domain' THEN pg_catalog.has_type_privilege(role.oid, candidate.object_oid, candidate.privilege_type || ' WITH GRANT OPTION')
               WHEN 'type' THEN pg_catalog.has_type_privilege(role.oid, candidate.object_oid, candidate.privilege_type || ' WITH GRANT OPTION')
               WHEN 'large_object' THEN pg_catalog.has_largeobject_privilege(role.oid, candidate.object_oid, candidate.privilege_type || ' WITH GRANT OPTION')
             END AS grantable
      FROM audited_roles role
      CROSS JOIN privilege_candidates candidate
    ),
    set_reachable_acl AS (
      SELECT DISTINCT privilege.role_oid, privilege.kind, privilege.object_name,
             privilege.privilege_type
      FROM role_privileges privilege
      JOIN application_roles member ON member.oid = privilege.role_oid
      JOIN pg_catalog.pg_roles parent
        ON parent.oid <> member.oid
       AND pg_catalog.pg_has_role(member.oid, parent.oid, 'SET')
      WHERE NOT privilege.effective
        AND CASE privilege.kind
          WHEN 'database' THEN pg_catalog.has_database_privilege(parent.oid, privilege.object_oid, privilege.privilege_type)
          WHEN 'schema' THEN pg_catalog.has_schema_privilege(parent.oid, privilege.object_oid, privilege.privilege_type)
          WHEN 'table' THEN pg_catalog.has_table_privilege(parent.oid, privilege.object_oid, privilege.privilege_type)
          WHEN 'column' THEN pg_catalog.has_column_privilege(parent.oid, privilege.object_oid, privilege.sub_id::smallint, privilege.privilege_type)
          WHEN 'sequence' THEN pg_catalog.has_sequence_privilege(parent.oid, privilege.object_oid, privilege.privilege_type)
          WHEN 'function' THEN pg_catalog.has_function_privilege(parent.oid, privilege.object_oid, privilege.privilege_type)
          WHEN 'procedure' THEN pg_catalog.has_function_privilege(parent.oid, privilege.object_oid, privilege.privilege_type)
          WHEN 'domain' THEN pg_catalog.has_type_privilege(parent.oid, privilege.object_oid, privilege.privilege_type)
          WHEN 'type' THEN pg_catalog.has_type_privilege(parent.oid, privilege.object_oid, privilege.privilege_type)
          WHEN 'large_object' THEN pg_catalog.has_largeobject_privilege(parent.oid, privilege.object_oid, privilege.privilege_type)
        END
    ),
    relation_roles AS (
      SELECT DISTINCT acl.role_oid, relation.oid
      FROM role_privileges acl
      JOIN application_relations relation
        ON (
          acl.kind IN ('table', 'sequence')
          AND acl.object_name = relation.nspname || '.' || relation.relname
        ) OR (
          acl.kind = 'column'
          AND left(acl.object_name, length(relation.nspname || '.' || relation.relname) + 1) =
              relation.nspname || '.' || relation.relname || '.'
        )
      WHERE acl.effective
    ),
    results AS (
      SELECT role.rolname AS role, 'attribute'::text AS kind,
             attribute.name || ':' || attribute.enabled AS value
      FROM application_roles role
      CROSS JOIN LATERAL (VALUES
        ('BYPASSRLS', role.rolbypassrls::text), ('CREATEDB', role.rolcreatedb::text),
        ('CREATEROLE', role.rolcreaterole::text),
        ('LOGIN', role.rolcanlogin::text), ('REPLICATION', role.rolreplication::text),
        ('SUPERUSER', role.rolsuper::text)
      ) attribute(name, enabled)
      UNION ALL
      SELECT member.rolname, 'membership',
             parent.rolname || ':ADMIN_OPTION:' || membership.admin_option || ':INHERIT_OPTION:' || membership.inherit_option ||
             ':SET_OPTION:' || membership.set_option
      FROM direct_memberships membership
      JOIN application_roles member ON member.oid = membership.member
      JOIN pg_catalog.pg_roles parent ON parent.oid = membership.parent
      UNION ALL
      SELECT role.rolname, 'privilege',
             acl.kind || ':' || acl.object_name || ':' ||
             acl.privilege_type || ':EFFECTIVE'
      FROM role_privileges acl
      LEFT JOIN application_roles role ON role.oid = acl.role_oid
      LEFT JOIN role_privileges public_acl
        ON acl.role_oid <> 0
       AND public_acl.role_oid = 0
       AND public_acl.kind = acl.kind
       AND public_acl.object_oid = acl.object_oid
       AND public_acl.sub_id = acl.sub_id
       AND public_acl.privilege_type = acl.privilege_type
      WHERE acl.effective
        AND NOT acl.relation_effective
        AND public_acl.effective IS NOT TRUE
      UNION ALL
      SELECT role.rolname, 'privilege', acl.kind || ':' || acl.object_name || ':' ||
             acl.privilege_type || ':EFFECTIVE_GRANTABLE'
      FROM role_privileges acl
      JOIN application_roles role ON role.oid = acl.role_oid
      WHERE acl.grantable AND NOT acl.relation_grantable
      UNION ALL
      SELECT role.rolname, 'privilege', acl.kind || ':' || acl.object_name || ':' ||
             acl.privilege_type || ':SET_REACHABLE'
      FROM set_reachable_acl acl
      JOIN application_roles role ON role.oid = acl.role_oid
      UNION ALL
      SELECT grantee.rolname,
             'privilege', acl.kind || ':' || acl.object_name || ':' ||
             acl.privilege_type || ':GRANTOR:' || grantor.rolname ||
             ':GRANTABLE:' || acl.is_grantable
      FROM expanded_acl acl
      LEFT JOIN application_roles grantee ON grantee.oid = acl.grantee
      JOIN pg_catalog.pg_roles grantor ON grantor.oid = acl.grantor
      WHERE acl.grantee = 0 OR grantee.oid IS NOT NULL
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
`;

export const readRolePrivilegeCensus = async (
  database: SQL,
): Promise<Census> => {
  const rows = await database.unsafe<CensusRow[]>(rolePrivilegeCensusQuery);

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

  const publicPrivileges: string[] = [];
  const census = new Map<string, RoleCensus>();
  for (const row of rows) {
    if (row.role === null) {
      if (row.kind !== "privilege") {
        return panic(`PUBLIC cannot hold a census ${row.kind}`);
      }
      publicPrivileges.push(row.value);
      continue;
    }
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
  return {
    public: publicPrivileges,
    roles: [...census.values()],
    policies,
  };
};

// PostgreSQL reserves the lowercase name, so no role line can collide with it.
const censusLines = (census: RolePrivilegeCensus) => [
  ...census.public.map((privilege) => `public ${privilege}`),
  ...census.roles.flatMap(({ role, attributes, memberships, privileges }) => [
    `${role} role`,
    ...attributes.map((attribute) => `${role} attribute:${attribute}`),
    ...memberships.map((membership) => `${role} membership:${membership}`),
    ...privileges.map((privilege) => `${role} ${privilege}`),
  ]),
];

const assertCensus = (
  expected: RolePrivilegeCensus,
  actual: RolePrivilegeCensus,
) => {
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
  ...roleCensus,
  policies: policyCensus,
});

export const assertCompleteCensus = (expected: Census, actual: Census) => {
  assertCensus(expected, actual);
  assertPolicyCensus(expected.policies, actual.policies);
};

const formatCensus = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export const writeRolePrivilegeCensus = (census: Census) => {
  const rolePrivilegeCensus: RolePrivilegeCensus = {
    public: census.public,
    roles: census.roles,
  };
  writeFileSync(censusPath, formatCensus(rolePrivilegeCensus));
  writeFileSync(policyCensusPath, formatCensus(census.policies));
};
