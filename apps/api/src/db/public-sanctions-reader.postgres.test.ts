import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { getTableName, sql } from "drizzle-orm";
import nodePath from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { stellaPublicSanctionsReader } from "@/api/db/rls";
import {
  sanctionsSources,
  sanctionsEditions,
  sanctionsEntryPayloads,
  sanctionsEditionEntries,
} from "@/api/db/schema";
import { markRlsDatabase } from "@/api/db/scoped";
import { createSanctionsPublicReadDb } from "@/api/lib/lists/sanctions/read-db";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { runMigrations } from "./migration-runner";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const readerRole = stellaPublicSanctionsReader.name;
const corpusTables = [
  sanctionsSources,
  sanctionsEditions,
  sanctionsEntryPayloads,
  sanctionsEditionEntries,
]
  .map(getTableName)
  .toSorted();
const migrationsFolder = nodePath.resolve(import.meta.dir, "../../drizzle");

// CI owns this isolated PostgreSQL database and applies the committed bundle.
// No schema-push policies, grant installation, or fixture DDL repairs are used.
describe.skipIf(!runPostgresTests)("migrated public sanctions reader", () => {
  test("migrated public reader can read the corpus and cannot read or mutate tenant rows on PostgreSQL", async () => {
    const url = databaseUrl ?? panic("DATABASE_URL is required");
    await withGatedTestClients(url, async ({ openClient }) => {
      const { sql: admin, db } = openClient({ max: 1 });
      const connection = await admin.reserve();
      try {
        await runMigrations({
          connection,
          migrationsFolder,
          databaseUrl: url,
          ebs: { type: "disabled" },
        });
      } finally {
        connection.release();
      }
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const application = `sanctions_application_${suffix}`;
      const source = `reader-${suffix}`;
      const edition = Bun.randomUUIDv7();
      const contentHash = suffix.repeat(2);
      const organizations = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
      const contacts = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
      const workspaces = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
      try {
        await admin.unsafe(`CREATE ROLE "${application}" NOLOGIN`);
        await admin.unsafe(
          `GRANT ${readerRole} TO "${application}" WITH SET TRUE, INHERIT FALSE`,
        );
        await admin`INSERT INTO sanctions_sources (id, issuer, marker_url) VALUES (${source}, 'EU', 'https://lists.example/reader')`;
        await admin`INSERT INTO sanctions_editions (id, source_id, marker_key, published_at, content_hash, entry_count, state)
          VALUES (${edition}, ${source}, ${contentHash}, '2026-09-20', ${contentHash}, 1, 'ready')`;
        await admin`UPDATE sanctions_sources SET active_edition_id = ${edition} WHERE id = ${source}`;
        await admin`INSERT INTO sanctions_entry_payloads (content_hash, payload) VALUES (${contentHash}, '{"name":"Reader corpus"}'::jsonb)`;
        await admin`INSERT INTO sanctions_edition_entries (edition_id, source_entry_id, content_hash) VALUES (${edition}, 'reader-entry', ${contentHash})`;
        for (const [index, organization] of organizations.entries()) {
          await admin`INSERT INTO organization (id, name, slug, created_at) VALUES (${organization}, 'Reader tenant', ${organization}, now())`;
          await admin`INSERT INTO contacts (id, organization_id, type, display_name) VALUES (${contacts.at(index)}, ${organization}, 'person', 'Private reader contact')`;
          await admin`INSERT INTO workspaces (id, organization_id, name, reference) VALUES (${workspaces.at(index)}, ${organization}, 'Private reader matter', ${organization})`;
          await admin`INSERT INTO entities (id, workspace_id, kind, name) VALUES (${Bun.randomUUIDv7()}, ${workspaces.at(index)}, 'file', 'Private reader file')`;
        }
        const reader = createSanctionsPublicReadDb(
          markRlsDatabase({
            transaction: async (fn) =>
              await db.transaction(async (tx) => {
                await tx.execute(
                  sql.raw(`SET LOCAL SESSION AUTHORIZATION "${application}"`),
                );
                return await fn(tx);
              }),
          }),
        );
        expect((await reader.validateRole()).isOk()).toBe(true);
        const posture = await reader(
          async (tx) =>
            await tx.execute(sql`
          SELECT current_user AS role, session_user AS session, current_setting('transaction_read_only') AS read_only,
            r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolcanlogin,
            EXISTS (SELECT 1 FROM pg_roles other WHERE other.rolname <> current_user AND
              (pg_has_role(current_user, other.oid, 'SET') OR pg_has_role(current_user, other.oid, 'USAGE') OR pg_has_role(current_user, other.oid, 'MEMBER'))) AS other_role
          FROM pg_roles r WHERE r.rolname = current_user
        `),
        );
        expect(posture.at(0)).toEqual({
          role: readerRole,
          session: application,
          read_only: "on",
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolbypassrls: false,
          rolcanlogin: false,
          other_role: false,
        });
        const rows = await reader(
          async (tx) =>
            await tx.execute(sql`
          SELECT s.id, e.id AS edition, p.payload, link.source_entry_id FROM sanctions_sources s
          JOIN sanctions_editions e ON e.id = s.active_edition_id
          JOIN sanctions_edition_entries link ON link.edition_id = e.id
          JOIN sanctions_entry_payloads p ON p.content_hash = link.content_hash WHERE s.id = ${source}
        `),
        );
        expect(rows).toEqual([
          {
            id: source,
            edition,
            payload: { name: "Reader corpus" },
            source_entry_id: "reader-entry",
          },
        ]);
        const policies = await db.execute<{
          table: string;
          enabled: boolean;
          forced: boolean;
          command: string;
          roles: string[];
          expression: string;
          check: string | null;
          permissive: boolean;
        }>(sql`
          SELECT c.relname AS "table", c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
            p.polcmd AS command, ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(p.polroles)) AS roles,
            pg_get_expr(p.polqual, p.polrelid) AS expression, pg_get_expr(p.polwithcheck, p.polrelid) AS "check", p.polpermissive AS permissive
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'public_sanctions_reader_access'
          WHERE n.nspname = 'public' AND c.relname IN (${sql.join(
            corpusTables.map((table) => sql`${table}`),
            sql.raw(","),
          )}) ORDER BY c.relname
        `);
        expect(policies).toEqual(
          corpusTables.map((table) => ({
            table,
            enabled: true,
            forced: true,
            command: "r",
            roles: [readerRole],
            expression: "true",
            check: null,
            permissive: true,
          })),
        );
        // Compare the complete live grant census with the actual committed grant statements.
        const migration = await Bun.file(
          nodePath.join(
            migrationsFolder,
            "20261003122400_public_sanctions_reader/migration.sql",
          ),
        ).text();
        const expectedGrants = [
          ...migration.matchAll(
            /GRANT SELECT\s*\(([^)]+)\)\s*ON TABLE\s+(\w+)\s+TO stella_public_sanctions_reader/gu,
          ),
        ]
          .flatMap((match) => {
            const columns = match.at(1) ?? panic("Missing grant columns");
            const table = match.at(2) ?? panic("Missing grant table");
            return columns
              .split(",")
              .map((column) => `${table}.${column.trim()}`);
          })
          .toSorted();
        expect(expectedGrants.length).toBeGreaterThan(0);
        const grants = await db.execute<{
          column: string;
          table_wide: boolean;
        }>(sql`
          SELECT c.relname || '.' || a.attname AS "column", has_table_privilege(${readerRole}, c.oid, 'SELECT') AS table_wide
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f') AND a.attnum > 0 AND NOT a.attisdropped
            AND has_column_privilege(${readerRole}, c.oid, a.attnum, 'SELECT') ORDER BY 1
        `);
        expect(grants.map(({ column }) => column).toSorted()).toEqual(
          expectedGrants,
        );
        expect(grants.every(({ table_wide }) => !table_wide)).toBe(true);
        for (const query of [
          sql`SELECT marker_url FROM sanctions_sources`,
          sql`SELECT * FROM contacts`,
          sql`SELECT * FROM entities`,
          sql`INSERT INTO contacts (id, organization_id, type, display_name) VALUES (${Bun.randomUUIDv7()}, ${organizations.at(0)}, 'person', 'Denied')`,
          sql`UPDATE contacts SET display_name = 'Denied' WHERE id = ${contacts.at(0)}`,
          sql`DELETE FROM contacts WHERE id = ${contacts.at(1)}`,
          sql`INSERT INTO entities (id, workspace_id, kind, name) VALUES (${Bun.randomUUIDv7()}, ${workspaces.at(0)}, 'file', 'Denied')`,
          sql`UPDATE entities SET name = 'Denied' WHERE workspace_id = ${workspaces.at(0)}`,
          sql`DELETE FROM entities WHERE workspace_id = ${workspaces.at(1)}`,
        ]) {
          expect(
            await rejectionOf(reader(async (tx) => await tx.execute(query))),
          ).toMatchObject({
            cause: {
              code: "ERR_POSTGRES_SERVER_ERROR",
              errno: expect.stringMatching(/^(42501|25006)$/u),
            },
          });
        }
        const writes = await db.execute(sql`
          SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f') AND (
            has_table_privilege(${readerRole}, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
            EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
              AND has_column_privilege(${readerRole}, c.oid, a.attnum, 'INSERT,UPDATE,REFERENCES')))
        `);
        expect(writes).toEqual([]);
      } finally {
        await admin`DELETE FROM entities WHERE workspace_id IN (${workspaces.at(0)}, ${workspaces.at(1)})`;
        await admin`DELETE FROM workspaces WHERE id IN (${workspaces.at(0)}, ${workspaces.at(1)})`;
        await admin`DELETE FROM contacts WHERE id IN (${contacts.at(0)}, ${contacts.at(1)})`;
        await admin`DELETE FROM organization WHERE id IN (${organizations.at(0)}, ${organizations.at(1)})`;
        await admin`UPDATE sanctions_sources SET active_edition_id = NULL WHERE id = ${source}`;
        await admin`DELETE FROM sanctions_edition_entries WHERE edition_id = ${edition}`;
        await admin`DELETE FROM sanctions_entry_payloads WHERE content_hash = ${contentHash}`;
        await admin`DELETE FROM sanctions_editions WHERE id = ${edition}`;
        await admin`DELETE FROM sanctions_edition_fanouts WHERE source_id = ${source}`;
        await admin`DELETE FROM sanctions_sources WHERE id = ${source}`;
        await admin.unsafe(`DROP ROLE IF EXISTS "${application}"`);
      }
    });
  }, 120_000);
});
