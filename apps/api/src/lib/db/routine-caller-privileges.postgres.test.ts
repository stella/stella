import { panic } from "better-result";
import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { withIsolatedPostgresCluster } from "@/api/tests/isolated-postgres-cluster";

import { parseMigrationStatements } from "../../../../../scripts/check-migration-safety";
import { runMigrations } from "../../db/migration-runner";

const migrationsFolder = path.resolve(import.meta.dir, "../../../drizzle");
const restrictedFunctions = parseMigrationStatements(
  readFileSync(
    path.join(
      migrationsFolder,
      "20261029074500_correspondence_source_maintenance/migration.sql",
    ),
    "utf-8",
  ),
).flatMap(({ raw }) => {
  if (!/^REVOKE EXECUTE ON FUNCTION /iu.test(raw)) {
    return [];
  }
  const signature =
    /^REVOKE EXECUTE ON FUNCTION (public\.[a-z_]+\([^)]*\)) FROM PUBLIC/iu
      .exec(raw)
      ?.at(1);
  if (!signature) {
    panic(`Cannot resolve restricted function declaration: ${raw}`);
  }
  return [signature];
});

// PostgreSQL tracks parsed SQL bodies in pg_depend, but not string SQL or
// PL/pgSQL bodies. Supplement its graph with calls in catalog bodies, masking
// comments and literals with the migration owner's lexer.
const readBodyCalls = async (database: SQL) => {
  const routines = await database.unsafe<
    { oid: number; name: string; body: string }[]
  >(`
    SELECT p.oid::int AS oid, p.proname AS name, p.prosrc AS body
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND l.lanname IN ('sql', 'plpgsql')
  `);
  const byName = new Map<string, number[]>();
  for (const routine of routines) {
    const ids = byName.get(routine.name);
    if (ids) {
      ids.push(routine.oid);
    } else {
      byName.set(routine.name, [routine.oid]);
    }
  }
  const edges: { caller: number; callee: number }[] = [];
  for (const routine of routines) {
    for (const statement of parseMigrationStatements(routine.body)) {
      const names = new Set(
        [...statement.text.matchAll(/\b([a-z_][a-z_0-9]*)\s*\(/giu)].flatMap(
          (match) => {
            const name = match.at(1);
            return name ? [name.toLowerCase()] : [];
          },
        ),
      );
      for (const identifier of statement.identifiers) {
        const tail = statement.text.slice(
          identifier.index + identifier.name.length + 2,
        );
        if (/^\s*\(/u.test(tail)) {
          names.add(identifier.name);
        }
      }
      for (const name of names) {
        const callees = byName.get(name);
        if (!callees) {
          continue;
        }
        for (const callee of callees) {
          edges.push({ caller: routine.oid, callee });
        }
      }
    }
  }
  return edges;
};

const callerPrivilegesQuery = `
WITH RECURSIVE
restricted AS (
  SELECT value::regprocedure::oid AS oid
  FROM jsonb_array_elements_text($1::text::jsonb)
),
function_edges AS (
  SELECT d.objid AS caller, d.refobjid AS callee
  FROM pg_catalog.pg_depend d
  WHERE d.classid = 'pg_catalog.pg_proc'::regclass
    AND d.refclassid = 'pg_catalog.pg_proc'::regclass
  UNION
  SELECT caller::oid, callee::oid
  FROM jsonb_to_recordset($2::text::jsonb) AS edge(caller bigint, callee bigint)
),
function_calls(caller, restricted) AS (
  SELECT oid, oid FROM restricted
  UNION
  SELECT edge.caller, calls.restricted
  FROM function_edges edge
  JOIN function_calls calls ON calls.caller = edge.callee
),
direct_relation_calls(relation, kind, object, restricted) AS (
  SELECT p.polrelid, 'policy', p.polname, calls.restricted
  FROM pg_catalog.pg_policy p
  JOIN pg_catalog.pg_depend d
    ON d.classid = 'pg_catalog.pg_policy'::regclass AND d.objid = p.oid
    AND d.refclassid = 'pg_catalog.pg_proc'::regclass
  JOIN function_calls calls ON calls.caller = d.refobjid
  UNION
  SELECT t.tgrelid, 'trigger', t.tgname, calls.restricted
  FROM pg_catalog.pg_trigger t
  JOIN function_calls calls ON calls.caller = t.tgfoid
  WHERE NOT t.tgisinternal
  UNION
  SELECT t.tgrelid, 'trigger', t.tgname, calls.restricted
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_depend d
    ON d.classid = 'pg_catalog.pg_trigger'::regclass AND d.objid = t.oid
    AND d.refclassid = 'pg_catalog.pg_proc'::regclass
  JOIN function_calls calls ON calls.caller = d.refobjid
  WHERE NOT t.tgisinternal
  UNION
  SELECT rewrite.ev_class, 'view', rewrite.rulename, calls.restricted
  FROM pg_catalog.pg_rewrite rewrite
  JOIN pg_catalog.pg_class view_row ON view_row.oid = rewrite.ev_class AND view_row.relkind IN ('v', 'm')
  JOIN pg_catalog.pg_depend d
    ON d.classid = 'pg_catalog.pg_rewrite'::regclass AND d.objid = rewrite.oid
    AND d.refclassid = 'pg_catalog.pg_proc'::regclass
  JOIN function_calls calls ON calls.caller = d.refobjid
),
relation_edges(relation, kind, object, dependency) AS (
  SELECT rewrite.ev_class, 'view', rewrite.rulename, d.refobjid
  FROM pg_catalog.pg_rewrite rewrite
  JOIN pg_catalog.pg_class view_row ON view_row.oid = rewrite.ev_class AND view_row.relkind IN ('v', 'm')
  JOIN pg_catalog.pg_depend d
    ON d.classid = 'pg_catalog.pg_rewrite'::regclass AND d.objid = rewrite.oid
    AND d.refclassid = 'pg_catalog.pg_class'::regclass
  UNION
  SELECT p.polrelid, 'policy', p.polname, d.refobjid
  FROM pg_catalog.pg_policy p
  JOIN pg_catalog.pg_depend d
    ON d.classid = 'pg_catalog.pg_policy'::regclass AND d.objid = p.oid
    AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid <> p.polrelid
),
relation_calls(relation, kind, object, restricted) AS (
  SELECT * FROM direct_relation_calls
  UNION
  SELECT edge.relation, edge.kind, edge.object, calls.restricted
  FROM relation_edges edge
  JOIN relation_calls calls ON calls.relation = edge.dependency
  WHERE calls.kind <> 'trigger'
),
required AS (
  SELECT DISTINCT role.rolname AS role, relation.oid::regclass::text AS relation,
    calls.kind, calls.object, calls.restricted::regprocedure::text AS routine,
    pg_catalog.has_function_privilege(role.oid, calls.restricted, 'EXECUTE') AS admitted
  FROM relation_calls calls
  JOIN pg_catalog.pg_class relation ON relation.oid = calls.relation
  CROSS JOIN pg_catalog.pg_roles role
  WHERE EXISTS (
    SELECT 1 FROM (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
      ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) privilege(name)
    WHERE pg_catalog.has_table_privilege(role.oid, relation.oid, privilege.name)
  ) OR EXISTS (
    SELECT 1 FROM (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) privilege(name)
    WHERE pg_catalog.has_any_column_privilege(role.oid, relation.oid, privilege.name)
  )
)
SELECT * FROM required ORDER BY role, relation, kind, object, routine
`;

type CallerPrivilege = {
  role: string;
  relation: string;
  kind: "policy" | "trigger" | "view";
  object: string;
  routine: string;
  admitted: boolean;
};

const readCallerPrivileges = async (database: SQL) =>
  await database.unsafe<CallerPrivilege[]>(callerPrivilegesQuery, [
    JSON.stringify(restrictedFunctions),
    JSON.stringify(await readBodyCalls(database)),
  ]);

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "restricted routine caller privileges",
  () => {
    // timeout: the invariant applies the complete migration chain in a disposable cluster.
    test("every table and view role can execute its policies and triggers", async () => {
      expect(restrictedFunctions.length).toBeGreaterThan(0);
      await withIsolatedPostgresCluster(
        {
          prefix: "routine-callers",
          database: "stella",
          user: "caller_admin",
          password: "fixture",
        },
        async (url) => {
          await withGatedTestClients(url, async ({ openClient }) => {
            await openClient().sql.unsafe(`
              CREATE ROLE caller_migrator LOGIN CREATEROLE CREATEDB NOINHERIT
                NOSUPERUSER NOBYPASSRLS NOREPLICATION PASSWORD 'fixture';
              ALTER DATABASE stella OWNER TO caller_migrator;
            `);
          });
          const migratingUrl = new URL(url);
          migratingUrl.username = "caller_migrator";
          migratingUrl.password = "fixture";
          await withGatedTestClients(
            migratingUrl.href,
            async ({ openClient }) => {
              const database = openClient().sql;
              const posture = await database.unsafe<{ superuser: boolean }[]>(
                "SELECT rolsuper AS superuser FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER",
              );
              expect([...posture]).toEqual([{ superuser: false }]);
              const connection = await database.reserve();
              try {
                await runMigrations({
                  connection,
                  databaseUrl: migratingUrl.href,
                  migrationsFolder,
                  ebs: { type: "disabled" },
                });
              } finally {
                await connection.release();
              }
              const publicExecution = await database.unsafe<
                { routine: string }[]
              >(
                `
              SELECT p.oid::regprocedure::text AS routine
              FROM pg_catalog.pg_proc p
              WHERE p.oid IN (SELECT value::regprocedure::oid FROM jsonb_array_elements_text($1::text::jsonb))
                AND EXISTS (
                  SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
                  WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
                )
            `,
                [JSON.stringify(restrictedFunctions)],
              );
              expect([...publicExecution]).toEqual([]);
              const privileges = await readCallerPrivileges(database);
              expect(privileges.length).toBeGreaterThan(0);
              expect(privileges.filter(({ admitted }) => !admitted)).toEqual(
                [],
              );

              const [target] = await database.unsafe<
                { call: string; signature: string }[]
              >(
                `
              SELECT format('%I.%I(%s)', n.nspname, p.proname,
                (SELECT string_agg('NULL::' || format_type(argument, NULL), ', ' ORDER BY ordinal)
                 FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY args(argument, ordinal))) AS call,
                p.oid::regprocedure::text AS signature
              FROM pg_catalog.pg_proc p
              JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
              WHERE p.oid IN (SELECT value::regprocedure::oid FROM jsonb_array_elements_text($1::text::jsonb))
                AND p.prorettype = 'boolean'::regtype
              ORDER BY p.oid LIMIT 1
            `,
                [JSON.stringify(restrictedFunctions)],
              );
              if (!target) {
                panic("Restricted policy function fixture is missing");
              }
              await database.unsafe(`
              CREATE ROLE routine_caller_fixture NOLOGIN;
              CREATE ROLE routine_caller_view_fixture NOLOGIN;
              CREATE TABLE public.routine_caller_fixture (id integer);
              GRANT SELECT (id) ON public.routine_caller_fixture TO routine_caller_fixture;
              CREATE POLICY routine_caller_fixture ON public.routine_caller_fixture USING (${target.call});
              CREATE FUNCTION public.routine_caller_fixture() RETURNS trigger LANGUAGE plpgsql AS $body$
                BEGIN PERFORM ${target.call}; RETURN NEW; END;
              $body$;
              CREATE TRIGGER routine_caller_fixture BEFORE INSERT ON public.routine_caller_fixture
                FOR EACH ROW EXECUTE FUNCTION public.routine_caller_fixture();
              CREATE VIEW public.routine_caller_fixture_view AS SELECT ${target.call} AS admitted;
              GRANT SELECT ON public.routine_caller_fixture_view TO routine_caller_fixture;
              CREATE VIEW public.routine_caller_fixture_outer_view AS SELECT * FROM public.routine_caller_fixture_view;
              GRANT SELECT ON public.routine_caller_fixture_outer_view TO routine_caller_view_fixture;
              CREATE POLICY routine_caller_fixture_view_policy ON public.routine_caller_fixture
                USING ((SELECT admitted FROM public.routine_caller_fixture_view));
              CREATE TABLE public.routine_caller_fixture_trigger_only (id integer);
              CREATE TRIGGER routine_caller_fixture_trigger_only BEFORE INSERT ON public.routine_caller_fixture_trigger_only
                FOR EACH ROW EXECUTE FUNCTION public.routine_caller_fixture();
              CREATE VIEW public.routine_caller_fixture_trigger_view AS SELECT * FROM public.routine_caller_fixture_trigger_only;
              GRANT SELECT ON public.routine_caller_fixture_trigger_view TO routine_caller_view_fixture;
            `);
              const fixturePrivileges = await readCallerPrivileges(database);
              expect(
                fixturePrivileges.filter(
                  ({ role, relation }) =>
                    role === "routine_caller_view_fixture" &&
                    relation === "routine_caller_fixture_trigger_view",
                ),
              ).toEqual([]);
              const outerMissing = fixturePrivileges.filter(
                ({ role, admitted }) =>
                  role === "routine_caller_view_fixture" && !admitted,
              );
              expect(outerMissing.length).toBeGreaterThan(0);
              expect(
                outerMissing.every(
                  ({ relation, routine }) =>
                    relation === "routine_caller_fixture_outer_view" &&
                    routine === target.signature,
                ),
              ).toBe(true);
              const missing = fixturePrivileges.filter(
                ({ role, admitted }) =>
                  role === "routine_caller_fixture" && !admitted,
              );
              expect(new Set(missing.map(({ kind }) => kind))).toEqual(
                new Set(["policy", "trigger", "view"]),
              );
              expect(
                missing.every(({ routine }) => routine === target.signature),
              ).toBe(true);
              expect(
                missing.some(
                  ({ object }) =>
                    object === "routine_caller_fixture_view_policy",
                ),
              ).toBe(true);
              await database.unsafe(
                `GRANT EXECUTE ON FUNCTION ${target.signature} TO routine_caller_fixture, routine_caller_view_fixture`,
              );
              expect(
                (await readCallerPrivileges(database)).filter(
                  ({ admitted }) => !admitted,
                ),
              ).toEqual([]);
            },
          );
        },
      );
    }, 120_000);
  },
);
