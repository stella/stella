import { panic } from "better-result";
import { expect, test } from "bun:test";

import {
  composedMetadataUrlSchema,
  METADATA_URL_SCHEMAS,
} from "@/api/handlers/case-law/ingestion/metadata-url-schemas";
import { readCommittedMigrations } from "@/api/tests/stella-table-privileges";

import { plainTextSourceUrlContractSql } from "../../../scripts/generate-plain-text-url-contract";

// Read what the migrator ultimately installs, rather than pinning an older contract.
const migration =
  readCommittedMigrations().findLast(({ sql }) =>
    sql.includes("CREATE OR REPLACE FUNCTION plain_text_source_url_schema("),
  )?.sql ?? panic("No committed source URL contract migration");
// The triggers that pass the source to the contract live in the guard itself.
const guardMigration = await Bun.file(
  new URL(
    "../../../drizzle/20261003123100_plain_text_markup_guard/migration.sql",
    import.meta.url,
  ),
).text();
const databaseUrlContracts = Object.fromEntries(
  Object.entries(METADATA_URL_SCHEMAS).map(([adapter, schema]) => [
    adapter,
    { base: schema ?? {}, composed: composedMetadataUrlSchema(schema) },
  ]),
);

test("database URL contracts derive from every declared adapter and composition", () => {
  expect(migration).toBe(plainTextSourceUrlContractSql());
  const generated = /\$url_schemas\$([\s\S]*?)\$url_schemas\$/u
    .exec(migration)
    ?.at(1);
  if (generated === undefined) {
    panic("migration has no generated URL contracts");
  }
  expect(JSON.parse(generated)).toEqual(databaseUrlContracts);
  for (const tableName of [
    "case_law_decisions",
    "case_law_decision_supplements",
  ]) {
    expect(guardMigration).toContain(`metadata, source_id ON ${tableName}`);
    expect(guardMigration).toContain(
      "OR NEW.source_id IS DISTINCT FROM OLD.source_id",
    );
  }
});
