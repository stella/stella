import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  decisionDatedFilterSql,
  decisionSortKeySql,
} from "@/api/lib/case-law/decision-search-order-sql";

const compile = (statement: ReturnType<typeof decisionSortKeySql>): string =>
  new PgDialect().sqlToQuery(statement).sql;

const RELEVANCE_SCORE = sql`blended_rank(d.id)`;

test("the relevance order sorts by the blended score it was handed", () => {
  expect(compile(decisionSortKeySql("relevance", RELEVANCE_SCORE))).toBe(
    compile(RELEVANCE_SCORE),
  );
});

test("the newest order sorts by the decision date", () => {
  const rendered = compile(decisionSortKeySql("newest", RELEVANCE_SCORE));

  expect(rendered).toContain("extract(epoch FROM d.decision_date)");
  expect(rendered).not.toContain("blended_rank");
});

/**
 * A decision the source never dated has no place in a date order, so it is
 * left out of the pages, the total and every facet rather than piled at one
 * end. Without the predicate the sort key below would need a floor to put
 * them at, and whichever end that floor landed on would be wrong for someone.
 */
test("the newest order keeps only the decisions it can rank", () => {
  expect(compile(decisionDatedFilterSql("newest"))).toContain(
    "d.decision_date IS NOT NULL",
  );
});

// Relevance ranks an undated decision as well as any other, so it keeps them.
test("the relevance order excludes nothing", () => {
  expect(compile(decisionDatedFilterSql("relevance")).trim()).toBe("");
});

// The predicate above is what lets the key be the bare column: a coalesce to
// some floor would be a second answer to where an undated decision sorts.
test("the newest sort key reads the column with no floor under it", () => {
  const rendered = compile(decisionSortKeySql("newest", RELEVANCE_SCORE));

  expect(rendered).toContain("extract(epoch FROM d.decision_date)");
  expect(rendered).not.toContain("coalesce");
});
