import { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { expect, test } from "bun:test";

import { ONLINE_MIGRATION_INDEXES } from "./online-migrations";

test("the personal key migration index matches the online repair definition", async () => {
  await using database = new PGlite();
  await database.exec(`
    CREATE TABLE organization_settings (id text PRIMARY KEY);
    CREATE TABLE apikey (
      id text PRIMARY KEY, metadata text, reference_id text, created_at timestamptz
    );
  `);
  const migration = await Bun.file(
    new URL(
      "../../drizzle/20261004120300_personal_api_keys/migration.sql",
      import.meta.url,
    ),
  ).text();
  // PGlite wraps exec in a transaction; preserve the DDL without the locking split.
  await database.exec(
    migration
      .replaceAll(" CONCURRENTLY", "")
      .replace(/^COMMIT;$/gmu, "")
      .replace(/^BEGIN;$/gmu, ""),
  );
  const index = ONLINE_MIGRATION_INDEXES.find(
    ({ name }) => name === "apikey_personal_owner_keyset_idx",
  );
  if (index === undefined) {
    panic("Missing personal key online index");
  }
  const result = await database.query<{ definition: string }>(
    "SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indexrelid = 'apikey_personal_owner_keyset_idx'::regclass",
  );
  expect(result.rows.at(0)?.definition).toBe(
    `CREATE INDEX ${index.name} ${index.definitionBody}`,
  );
}, 15_000);
