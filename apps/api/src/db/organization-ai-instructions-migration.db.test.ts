import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { rejectionOf } from "@stll/property-testing/rejection";

import { ORGANIZATION_AI_INSTRUCTIONS_MAX_LENGTH } from "./organization-settings-constants";

const migrationSql = readFileSync(
  new URL(
    "../../drizzle/20261031031854_organization_ai_instructions/migration.sql",
    import.meta.url,
  ),
  "utf-8",
).replaceAll("--> statement-breakpoint", "");

test("organization instructions expand existing settings and validate their bounded text online", async () => {
  await using database = new PGlite();
  await database.exec(`CREATE TABLE organization_settings (organization_id text PRIMARY KEY);
    INSERT INTO organization_settings VALUES ('advokáti-řehák'), ('kancelária-žiak');`);
  await database.exec(migrationSql);
  expect(
    (
      await database.query(
        "SELECT ai_instructions FROM organization_settings ORDER BY organization_id",
      )
    ).rows,
  ).toEqual([{ ai_instructions: "" }, { ai_instructions: "" }]);
  const constraintState = () =>
    database.query<{ convalidated: boolean }>(
      "SELECT convalidated FROM pg_constraint WHERE conname = 'organization_settings_ai_instructions_length_check'",
    );
  expect((await constraintState()).rows).toEqual([{ convalidated: false }]);
  await database.query(
    "UPDATE organization_settings SET ai_instructions = $1 WHERE organization_id = $2",
    ["Řiďte se českým právem. ".repeat(10), "advokáti-řehák"],
  );
  await database.query(
    "UPDATE organization_settings SET ai_instructions = $1 WHERE organization_id = $2",
    ["§".repeat(ORGANIZATION_AI_INSTRUCTIONS_MAX_LENGTH), "kancelária-žiak"],
  );
  expect(
    await rejectionOf(
      database.query("UPDATE organization_settings SET ai_instructions = $1", [
        "§".repeat(ORGANIZATION_AI_INSTRUCTIONS_MAX_LENGTH + 1),
      ]),
    ),
  ).toMatchObject({
    message: expect.stringContaining(
      "organization_settings_ai_instructions_length_check",
    ),
  });
  await database.exec(
    "ALTER TABLE organization_settings VALIDATE CONSTRAINT organization_settings_ai_instructions_length_check",
  );
  expect((await constraintState()).rows).toEqual([{ convalidated: true }]);
});
