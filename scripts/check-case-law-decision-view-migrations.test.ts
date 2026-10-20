import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  decisionViewMigrationViolation,
  decisionViewNamesFromSchema,
} from "./check-case-law-decision-view-migrations";

const schema = readFileSync(
  path.resolve(import.meta.dir, "../apps/api/src/db/schema/case-law.ts"),
  "utf-8",
);
const viewNames = decisionViewNamesFromSchema(schema);
const alterTable =
  'ALTER TABLE "case_law_decisions" ADD COLUMN "example" text;';
const recreate = (viewName: string) =>
  `CREATE OR REPLACE VIEW "${viewName}" AS SELECT * FROM "case_law_decisions";`;

describe("case-law decision view migration guard", () => {
  test("rejects a column addition that recreates no decision views", () => {
    expect(decisionViewMigrationViolation(alterTable, viewNames)).toContain(
      viewNames.join(", "),
    );
  });

  test("accepts a column change that recreates both decision views", () => {
    const sql = [alterTable, ...viewNames.map(recreate)].join("\n");
    expect(decisionViewMigrationViolation(sql, viewNames)).toBeUndefined();
  });

  test("rejects a column change that recreates only one decision view", () => {
    const sql = [alterTable, recreate(viewNames[0]!)].join("\n");
    expect(decisionViewMigrationViolation(sql, viewNames)).toContain(
      viewNames[1]!,
    );
  });

  test("accepts the source hash version migration", () => {
    const sql = readFileSync(
      path.resolve(
        import.meta.dir,
        "../apps/api/drizzle/20261020013635_case_law_source_hash_version/migration.sql",
      ),
      "utf-8",
    );
    expect(decisionViewMigrationViolation(sql, viewNames)).toBeUndefined();
  });
});
