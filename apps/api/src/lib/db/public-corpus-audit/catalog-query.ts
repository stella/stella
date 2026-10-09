import { sql } from "drizzle-orm";

type CatalogQueryArgs = { schemaName: string; tableName: string };
// sql-perf-allow: bounded by one named relation and its PostgreSQL catalog privilege/dependency metadata
export const publicCorpusCatalogQuery = ({
  schemaName,
  tableName,
}: CatalogQueryArgs) => sql`
  SELECT relation.relname AS name, namespace.nspname AS schema,
    relation.relkind::text AS kind,
    relation.relrowsecurity AS enabled, relation.relforcerowsecurity AS forced,
    (has_table_privilege('stella', relation.oid,
       'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
     OR has_any_column_privilege('stella', relation.oid,
       'SELECT, INSERT, UPDATE, REFERENCES')) AS "appPrivileges",
    (EXISTS (SELECT 1 FROM aclexplode(COALESCE(relation.relacl, acldefault('r', relation.relowner))) acl
             WHERE acl.grantee <> relation.relowner)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute column_info,
                      LATERAL aclexplode(column_info.attacl) acl
                WHERE column_info.attrelid = relation.oid AND acl.grantee <> relation.relowner)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
                WHERE role.rolcanlogin AND NOT role.rolsuper AND role.oid <> relation.relowner
                  AND (has_table_privilege(role.oid, relation.oid,
                    'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
                    OR has_any_column_privilege(role.oid, relation.oid, 'SELECT, INSERT, UPDATE, REFERENCES')))) AS "otherRolePrivileges",
    EXISTS (SELECT 1 FROM pg_catalog.pg_trigger trigger
            WHERE trigger.tgrelid = relation.oid AND NOT trigger.tgisinternal) AS "userTriggers",
    EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite rule
            WHERE rule.ev_class = relation.oid AND rule.rulename <> '_RETURN') AS "rewriteRules",
    EXISTS (SELECT 1 FROM pg_catalog.pg_inherits inheritance
            WHERE inheritance.inhrelid = relation.oid OR inheritance.inhparent = relation.oid) AS inheritance,
    EXISTS (SELECT 1 FROM pg_catalog.pg_constraint dependent
            WHERE dependent.contype = 'f'
              AND (dependent.confrelid = relation.oid OR dependent.conrelid = relation.oid)) AS "cascadingDependents",
    EXISTS (
      WITH RECURSIVE related(oid) AS (
        SELECT relation.oid
        UNION
        SELECT rule.ev_class FROM related
        JOIN pg_catalog.pg_depend dependency ON dependency.refobjid = related.oid
          AND dependency.refclassid = 'pg_class'::regclass AND dependency.classid = 'pg_rewrite'::regclass
        JOIN pg_catalog.pg_rewrite rule ON rule.oid = dependency.objid
      )
      SELECT 1 FROM related JOIN pg_catalog.pg_class view_relation ON view_relation.oid = related.oid
      WHERE view_relation.relkind IN ('v', 'm')
        AND (has_table_privilege('stella', view_relation.oid, 'SELECT')
          OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(view_relation.relacl, acldefault('r', view_relation.relowner))) acl
                     WHERE acl.grantee <> view_relation.relowner))
    ) AS "accessibleViews",
    EXISTS (SELECT 1 FROM pg_catalog.pg_proc routine
            WHERE routine.prosecdef AND (
              position(relation.relname IN routine.prosrc) > 0
              OR EXISTS (SELECT 1 FROM pg_catalog.pg_depend dependency
                         WHERE dependency.classid = 'pg_proc'::regclass AND dependency.objid = routine.oid
                           AND dependency.refclassid = 'pg_class'::regclass AND dependency.refobjid = relation.oid)
              OR (routine.pronamespace = relation.relnamespace AND routine.prosrc ~* '\\mEXECUTE\\M')
            ) AND (has_function_privilege('stella', routine.oid, 'EXECUTE')
              OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(routine.proacl, acldefault('f', routine.proowner))) acl
                         WHERE acl.grantee <> routine.proowner))) AS "securityDefiners",
    COALESCE((SELECT json_agg(json_build_object(
      'command', policy.polcmd::text, 'publicOnly', policy.polroles = ARRAY[0::oid],
      'permissive', policy.polpermissive,
      'using', pg_get_expr(policy.polqual, policy.polrelid),
      'check', pg_get_expr(policy.polwithcheck, policy.polrelid)
    )) FROM pg_catalog.pg_policy policy WHERE policy.polrelid = relation.oid), '[]'::json) AS policies
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = ${schemaName} AND relation.relname = ${tableName}
`;
