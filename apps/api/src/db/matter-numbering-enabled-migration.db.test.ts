import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

/**
 * Organizations that exist when matter numbering becomes a setting keep their
 * numbered titles, whether or not they already have a settings row.
 * Organizations created afterwards start with numbering off.
 */

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20261014073500_matter_numbering_enabled/migration.sql",
);

const SCHEMA_BEFORE = `
CREATE TABLE organization (id text PRIMARY KEY);
CREATE TABLE organization_settings (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL UNIQUE REFERENCES organization (id),
  matter_number_padding integer DEFAULT 3 NOT NULL
);
INSERT INTO organization (id) VALUES ('org_with_row'), ('org_without_row');
INSERT INTO organization_settings (id, organization_id, matter_number_padding)
  VALUES (gen_random_uuid(), 'org_with_row', 5);
`;

const migrationSql = readFileSync(MIGRATION_PATH, "utf-8").replaceAll(
  "--> statement-breakpoint",
  "",
);

const numberingByOrganization = async (
  database: PGlite,
): Promise<Record<string, boolean>> => {
  const result = await database.query<{
    organization_id: string;
    matter_numbering_enabled: boolean;
  }>(
    `SELECT organization_id, matter_numbering_enabled
       FROM organization_settings ORDER BY organization_id`,
  );
  return Object.fromEntries(
    result.rows.map((row) => [
      row.organization_id,
      row.matter_numbering_enabled,
    ]),
  );
};

test("every existing organization keeps numbered titles, with or without a settings row", async () => {
  await using database = new PGlite();
  await database.exec(SCHEMA_BEFORE);

  await database.exec(migrationSql);

  expect(await numberingByOrganization(database)).toEqual({
    org_with_row: true,
    org_without_row: true,
  });
  const kept = await database.query<{ matter_number_padding: number }>(
    `SELECT matter_number_padding FROM organization_settings
      WHERE organization_id = 'org_with_row'`,
  );
  expect(kept.rows).toEqual([{ matter_number_padding: 5 }]);
});

test("an organization created after the migration starts with numbering off", async () => {
  await using database = new PGlite();
  await database.exec(SCHEMA_BEFORE);
  await database.exec(migrationSql);

  await database.exec(`
    INSERT INTO organization (id) VALUES ('org_new');
    INSERT INTO organization_settings (id, organization_id)
      VALUES (gen_random_uuid(), 'org_new');
  `);

  expect((await numberingByOrganization(database))["org_new"]).toBe(false);
});
