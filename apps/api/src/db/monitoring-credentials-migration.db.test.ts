import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import { MONITORING_SESSION_INDEXES } from "@/api/lib/synthetic-principal/indexes";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const migration = readFileSync(
  new URL(
    "../../drizzle/20261019090000_monitoring_credentials/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);

describe.skipIf(!enabled)("monitoring credential migration", () => {
  test("session deletion removes bound room tokens and preserves unbound tokens", async () => {
    const databaseUrl = process.env["DATABASE_URL"];
    if (!databaseUrl) {
      panic("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { sql: client } = openClient({ max: 1 });
      const schema = `monitoring_credentials_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      await client.unsafe(`CREATE SCHEMA ${schema}`);
      try {
        await client.unsafe(`SET search_path TO ${schema}, public`);
        await client.unsafe(`
          CREATE TABLE session (id text PRIMARY KEY);
          CREATE TABLE folio_collab_room_tokens (id text PRIMARY KEY);
          INSERT INTO session (id) VALUES ('parent-session'), ('other-session');
          INSERT INTO folio_collab_room_tokens (id) VALUES ('existing-unbound');
        `);
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) {
            await client.unsafe(statement);
          }
        }
        for (const index of MONITORING_SESSION_INDEXES) {
          await client.unsafe(
            index.createSql.replaceAll("public.", () => `${schema}.`),
          );
          const rows = await client`
            SELECT pg_get_indexdef(index_relation.oid) AS definition, index_state.indisvalid AS valid
            FROM pg_catalog.pg_class index_relation
            JOIN pg_catalog.pg_namespace namespace ON namespace.oid = index_relation.relnamespace
            JOIN pg_catalog.pg_index index_state ON index_state.indexrelid = index_relation.oid
            WHERE namespace.nspname = ${schema} AND index_relation.relname = ${index.name}
          `;
          expect(rows).toEqual([
            expect.objectContaining({
              definition: `CREATE INDEX ${index.name} ${index.definitionBody.replaceAll("public.", () => `${schema}.`)}`,
              valid: true,
            }),
          ]);
        }
        const constraint =
          await client`SELECT convalidated FROM pg_constraint WHERE conrelid = 'folio_collab_room_tokens'::regclass AND conname = 'folio_collab_room_tokens_source_session_id_session_id_fk'`;
        expect(constraint).toEqual([
          expect.objectContaining({ convalidated: false }),
        ]);
        expect(
          await client`SELECT source_session_id FROM folio_collab_room_tokens WHERE id = 'existing-unbound'`,
        ).toEqual([expect.objectContaining({ source_session_id: null })]);

        await client`INSERT INTO folio_collab_room_tokens (id, source_session_id) VALUES ('new-unbound', NULL), ('bound', 'parent-session'), ('other-bound', 'other-session')`;
        const missingParent = await Result.tryPromise(
          async () =>
            client`INSERT INTO folio_collab_room_tokens (id, source_session_id) VALUES ('missing-parent', 'absent-session')`,
        );
        expect(missingParent.isErr()).toBe(true);
        if (missingParent.isErr()) {
          expect(
            isPgConstraintError(
              missingParent.error,
              PG_ERROR.FOREIGN_KEY_VIOLATION,
              "folio_collab_room_tokens_source_session_id_session_id_fk",
            ),
          ).toBe(true);
        }

        await client`DELETE FROM session WHERE id = 'parent-session'`;
        const remaining =
          await client`SELECT id, source_session_id FROM folio_collab_room_tokens ORDER BY id`;
        expect(remaining).toEqual([
          expect.objectContaining({
            id: "existing-unbound",
            source_session_id: null,
          }),
          expect.objectContaining({
            id: "new-unbound",
            source_session_id: null,
          }),
          expect.objectContaining({
            id: "other-bound",
            source_session_id: "other-session",
          }),
        ]);
      } finally {
        await client.unsafe("SET search_path TO public");
        await client.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  });
});
