import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { createSafeId } from "@/api/lib/branded-types";
import {
  REVIEW_RESET_CLEARED_TABLES,
  sweepReviewOrganization,
} from "@/api/lib/review-organization/reset-scope";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

const OWNER_ERASURE_TABLES = [
  "billing_arrangements",
  "correspondence_allowed_sender_matters",
  "correspondence_drop_logs",
  "invoice_lines",
  "number_series",
  "number_series_allocations",
  "number_series_counters",
  "seller_profiles",
  "vat_rates",
] as const;

describe.skipIf(!enabled)("review reset policy census", () => {
  test("clears every table for former users across matters without feature enrolment", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db, sql: client } = openClient();
      const census = openClient().sql;
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const schema = `reset_census_${suffix}`;
      const owner = `reset_owner_${suffix}`;
      const organizationId = mintAuthProviderId<"organization">();
      const reviewerId = mintAuthProviderId<"user">();
      const formerUserId = mintAuthProviderId<"user">();
      const workspaceIds = [
        createSafeId<"workspace">(),
        createSafeId<"workspace">(),
      ];
      const [login] = await client<
        { name: string }[]
      >`SELECT current_user AS name`;
      if (login === undefined) {
        panic("Fixture login required");
      }
      // Copy shipped policies, not a second hand-maintained policy model. FK and
      // required payload fields are immaterial to the visibility census.
      const policies = await client<
        {
          table: string;
          name: string;
          command: string;
          permissive: boolean;
          roles: string[];
          using: string | null;
          check: string | null;
        }[]
      >`
        SELECT c.relname AS table, p.polname AS name,
          CASE p.polcmd WHEN '*' THEN 'ALL' WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' END AS command,
          p.polpermissive AS permissive,
          ARRAY(SELECT CASE WHEN role = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(role) END FROM unnest(p.polroles) role) AS roles,
          pg_get_expr(p.polqual, p.polrelid) AS using, pg_get_expr(p.polwithcheck, p.polrelid) AS check
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY(${`{${REVIEW_RESET_CLEARED_TABLES.join(",")}}`})`;
      expect(
        policies
          .filter(
            (policy) =>
              OWNER_ERASURE_TABLES.some((table) => table === policy.table) &&
              policy.name === "review_reset_owner_delete",
          )
          .map(({ table }) => table)
          .toSorted(),
      ).toEqual([...OWNER_ERASURE_TABLES].toSorted());
      const columns = await client<{ table: string; name: string }[]>`
        SELECT table_name AS table, column_name AS name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY(${`{${[...REVIEW_RESET_CLEARED_TABLES, "workspaces"].join(",")}}`})`;
      const forced = await client<
        { name: string }[]
      >`SELECT relname AS name FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relforcerowsecurity`;
      const forcedNames = new Set(forced.map(({ name }) => name));
      await client.unsafe(`CREATE SCHEMA ${schema}; CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
        GRANT ${owner} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
        GRANT stella TO ${owner} WITH INHERIT FALSE, SET TRUE;
        GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${owner}; GRANT USAGE ON SCHEMA ${schema} TO stella;
        SET search_path TO ${schema}, public`);
      try {
        await client.unsafe(`CREATE TABLE workspaces (LIKE public.workspaces);
          CREATE TABLE member (organization_id text, user_id text, role text);
          GRANT SELECT ON workspaces, member TO stella;
          CREATE TABLE user_files (id uuid, thread_id uuid);
          ALTER TABLE workspaces OWNER TO ${owner}; ALTER TABLE member OWNER TO ${owner}; ALTER TABLE user_files OWNER TO ${owner}`);
        for (const { name } of columns.filter(
          ({ table }) => table === "workspaces",
        )) {
          await client.unsafe(
            `ALTER TABLE workspaces ALTER COLUMN ${identifier(name)} DROP NOT NULL`,
          );
        }
        await client`INSERT INTO member VALUES (${organizationId}, ${reviewerId}, 'owner')`;
        for (const workspaceId of workspaceIds) {
          await client`INSERT INTO workspaces (id, organization_id) VALUES (${workspaceId}, ${organizationId})`;
        }
        for (const name of REVIEW_RESET_CLEARED_TABLES) {
          const table = identifier(name);
          await client.unsafe(
            `CREATE TABLE ${table} (LIKE public.${table}); ALTER TABLE ${table} OWNER TO ${owner}; GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO stella`,
          );
          const tableColumns = columns
            .filter((column) => column.table === name)
            .map(({ name: column }) => column);
          await client.unsafe(
            tableColumns
              .map(
                (column) =>
                  `ALTER TABLE ${table} ALTER COLUMN ${identifier(column)} DROP NOT NULL, ALTER COLUMN ${identifier(column)} DROP DEFAULT`,
              )
              .join("; "),
          );
          for (const policy of policies.filter(
            (candidate) => candidate.table === name,
          )) {
            const using =
              policy.using === null ? "" : ` USING (${policy.using})`;
            const check =
              policy.check === null ? "" : ` WITH CHECK (${policy.check})`;
            await client.unsafe(
              `CREATE POLICY ${identifier(policy.name)} ON ${table} AS ${policy.permissive ? "PERMISSIVE" : "RESTRICTIVE"} FOR ${policy.command} TO ${policy.roles.map((role) => (role === "PUBLIC" ? role : identifier(role))).join(", ")}${using}${check}`,
            );
          }
          if (forcedNames.has(name)) {
            await client.unsafe(
              `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
            );
          }
          await client.unsafe(
            `CREATE POLICY census_login ON ${table} FOR ALL TO ${identifier(login.name)} USING (true) WITH CHECK (true)`,
          );
          const seedColumns = [
            "organization_id",
            ...[
              "user_id",
              "created_by",
              "owner_user_id",
              "actor_user_id",
              "workspace_id",
              "entity_feature_gate",
            ].filter((column) => tableColumns.includes(column)),
          ];
          for (const workspaceId of workspaceIds) {
            const values = seedColumns.map((column) => {
              switch (column) {
                case "organization_id":
                  return organizationId;
                case "workspace_id":
                  return workspaceId;
                case "entity_feature_gate":
                  return "legal-lists";
                default:
                  return formerUserId;
              }
            });
            await client.unsafe(
              `INSERT INTO ${table} (${seedColumns.map(identifier).join(", ")}) VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})`,
              values,
            );
          }
        }
        const [posture] =
          await client`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${owner}`;
        expect(posture).toMatchObject({ rolsuper: false, rolbypassrls: false });
        const swept = await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('role', ${owner}, true), set_config('app.enabled_features', '[]', true)`,
          );
          const removed = await sweepReviewOrganization(
            tx,
            organizationId,
            reviewerId,
          );
          expect(
            [...removed.keys()].filter((name) => name !== "user_files"),
          ).toEqual([...REVIEW_RESET_CLEARED_TABLES]);
          return removed;
        });
        // A different connection, outside the scoped owner, counts every row.
        for (const name of REVIEW_RESET_CLEARED_TABLES) {
          const rows = await census.unsafe<{ organization_id: string }[]>(
            `SELECT organization_id FROM ${schema}.${identifier(name)}`,
          );
          expect([...rows], name).toEqual([]);
          expect(swept.get(name), name).toBe(2);
        }
      } finally {
        await client.unsafe(
          `RESET ROLE; RESET search_path; DROP SCHEMA ${schema} CASCADE; DROP ROLE ${owner}`,
        );
      }
    });
  });
});
