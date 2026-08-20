import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { legislationDocuments } from "@/api/db/schema";

const INDEX_NAME = "legislation_documents_updated_id_idx";
const MIGRATION = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20260820120000_legislation_updated_trail_index/migration.sql",
);

test("the legislation update trail has the same key order in schema and migration", () => {
  const index = getTableConfig(legislationDocuments).indexes.find(
    (candidate) => candidate.config.name === INDEX_NAME,
  );
  expect(
    index?.config.columns.map((column) =>
      "name" in column ? column.name : undefined,
    ),
  ).toEqual(["updated_at", "id"]);

  const createStatement = /CREATE INDEX CONCURRENTLY[^;]+;/u
    .exec(readFileSync(MIGRATION, "utf-8"))
    ?.at(0)
    ?.replaceAll(/\s+/gu, " ")
    .trim();
  expect(createStatement).toBe(
    `CREATE INDEX CONCURRENTLY "${INDEX_NAME}" ON "legislation_documents" ("updated_at", "id");`,
  );
});
