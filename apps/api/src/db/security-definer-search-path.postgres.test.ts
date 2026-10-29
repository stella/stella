import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type DefinerFunction = {
  identity: string;
  settings: string[] | null;
};

const searchPathSetting = ({ settings }: DefinerFunction) =>
  settings?.find((setting) => setting.startsWith("search_path="));

const hasSafeSearchPath = (routine: DefinerFunction) => {
  const setting = searchPathSetting(routine);
  if (!setting) {
    return false;
  }
  const value = setting.slice("search_path=".length).trim();
  if (!value || value.toLowerCase() === "from current") {
    return false;
  }
  const lastEntry = value
    .split(",")
    .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .at(-1);
  return lastEntry?.toLowerCase() === "pg_temp";
};

const describeViolation = (routine: DefinerFunction) =>
  `${routine.identity}: ${searchPathSetting(routine)?.slice("search_path=".length) ?? "unset"}`;

describe.skipIf(!enabled)("security-definer search paths (postgres)", () => {
  test("every security-definer function ends its search path with pg_temp", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const fixtureSchema = `definer_path_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const schema = sql.identifier(fixtureSchema);
      await db.execute(sql`CREATE SCHEMA ${schema}`);
      try {
        await db.execute(sql`
          CREATE FUNCTION ${schema}.unsafe_fixture() RETURNS integer
          LANGUAGE sql SECURITY DEFINER
          SET search_path = pg_catalog, public
          AS 'SELECT 1'
        `);
        await db.execute(sql`
          CREATE FUNCTION ${schema}.safe_fixture() RETURNS integer
          LANGUAGE sql SECURITY DEFINER
          SET search_path = pg_catalog, public, pg_temp
          AS 'SELECT 1'
        `);

        const routines = await db.execute<DefinerFunction>(sql`
          SELECT
            n.nspname || '.' || p.proname || '(' ||
              pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS identity,
            p.proconfig AS settings
          FROM pg_catalog.pg_proc AS p
          JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
          WHERE p.prosecdef
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND NOT EXISTS (
              SELECT 1
              FROM pg_catalog.pg_depend AS dependency
              WHERE dependency.classid = 'pg_proc'::pg_catalog.regclass
                AND dependency.objid = p.oid
                AND dependency.deptype = 'e'
            )
          ORDER BY identity
        `);
        const fixtureViolations = routines
          .filter(({ identity }) => identity.startsWith(`${fixtureSchema}.`))
          .filter((routine) => !hasSafeSearchPath(routine))
          .map(describeViolation);
        expect(fixtureViolations).toEqual([
          `${fixtureSchema}.unsafe_fixture(): pg_catalog, public`,
        ]);

        const violations = routines
          .filter(({ identity }) => !identity.startsWith(`${fixtureSchema}.`))
          .filter((routine) => !hasSafeSearchPath(routine))
          .map(describeViolation);
        expect(violations).toEqual([]);

        await db.execute(sql`
          CREATE TABLE ${schema}.compactions (
            thread_id uuid,
            memory_extraction_organization_id text,
            memory_extraction_data_workspace_ids uuid[],
            memory_extraction_consent_at timestamptz,
            memory_extracted_at timestamptz,
            status text,
            created_at timestamptz
          );
          CREATE TRIGGER address_compaction BEFORE INSERT ON ${schema}.compactions
          FOR EACH ROW EXECUTE FUNCTION public.stella_address_and_queue_memory_compaction();

          CREATE TABLE ${schema}.workspaces (id uuid, organization_id text);
          CREATE TRIGGER delete_memories BEFORE DELETE ON ${schema}.workspaces
          FOR EACH ROW EXECUTE FUNCTION public.stella_delete_source_matter_memories();

          CREATE TABLE ${schema}.memories (user_id text, created_by text);
          CREATE TRIGGER guard_users BEFORE INSERT ON ${schema}.memories
          FOR EACH ROW EXECUTE FUNCTION public.stella_guard_ai_memory_active_users();
        `);
        const fixtureId = Bun.randomUUIDv7();
        await db.execute(sql`INSERT INTO ${schema}.compactions
          (thread_id, status, created_at)
          VALUES (${fixtureId}, 'inactive', pg_catalog.now())`);
        await db.execute(
          sql`INSERT INTO ${schema}.workspaces VALUES (${fixtureId}, 'fixture')`,
        );
        await db.execute(
          sql`DELETE FROM ${schema}.workspaces WHERE id = ${fixtureId}`,
        );
        await db.execute(
          sql`INSERT INTO ${schema}.memories VALUES (NULL, NULL)`,
        );
        const counts = await db.execute<{ count: number }>(sql`
          SELECT (
            (SELECT count(*) FROM ${schema}.compactions) +
            (SELECT count(*) FROM ${schema}.memories)
          )::integer AS count
        `);
        expect(counts.at(0)?.count).toBe(2);
      } finally {
        await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  });
});
