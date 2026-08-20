import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { caseLawCitations } from "@/api/db/schema";

const migration = readFileSync(
  nodePath.resolve(
    import.meta.dir,
    "../../../drizzle/20260820140000_case_law_citation_pages/migration.sql",
  ),
  "utf-8",
);

const pageIndexNames = new Set([
  "case_law_citations_citing_page_idx",
  "case_law_citations_cited_page_idx",
]);
const pageIndexes = getTableConfig(caseLawCitations).indexes.filter(
  ({ config }) => config.name !== undefined && pageIndexNames.has(config.name),
);

test("citation page indexes match the migration", () => {
  expect(
    pageIndexes.map(({ config }) => ({
      columns: config.columns.map((column) =>
        "name" in column && typeof column.name === "string"
          ? column.name
          : null,
      ),
      name: config.name,
      partial: config.where !== undefined,
    })),
  ).toEqual([
    {
      columns: ["citing_decision_id", "id"],
      name: "case_law_citations_citing_page_idx",
      partial: false,
    },
    {
      columns: ["cited_decision_id", "id"],
      name: "case_law_citations_cited_page_idx",
      partial: true,
    },
  ]);
  expect(migration).toContain(
    '"case_law_citations_citing_page_idx"\n  ON "case_law_citations" ("citing_decision_id", "id")',
  );
  expect(migration).toContain(
    '"case_law_citations_cited_page_idx"\n  ON "case_law_citations" ("cited_decision_id", "id")',
  );
});
