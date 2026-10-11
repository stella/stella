import { expect, test } from "bun:test";

import { publishedCaseLawDecisionIndexPredicateSql } from "./published-decisions-sql";

test("published decisions view uses the canonical partial-index predicate", async () => {
  const migration = await Bun.file(
    new URL(
      "../../../drizzle/20261010212200_case_law_public_decision_views/migration.sql",
      import.meta.url,
    ),
  ).text();
  const publishedView = migration.match(
    /CREATE VIEW "case_law_published_decisions"[\s\S]*?--> statement-breakpoint/u,
  )?.[0];

  expect(publishedView).toContain(
    `WHERE ${publishedCaseLawDecisionIndexPredicateSql()};`,
  );
});
