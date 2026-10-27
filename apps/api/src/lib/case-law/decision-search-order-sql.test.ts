import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { createSafeId } from "@/api/lib/branded-types";
import { decisionDateRankSql } from "@/api/lib/case-law/decision-date-order";
import {
  decisionSearchCursorAfterSql,
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

// The search sorts by this key descending, which is the newest date order
// only because the rank puts an undated decision below every dated one.
test("the newest order sorts by the shared date rank", () => {
  const rendered = compile(decisionSortKeySql("newest", RELEVANCE_SCORE));

  expect(rendered).toBe(
    compile(decisionDateRankSql("newest", sql`d.decision_date`)),
  );
  expect(rendered).toContain("'-infinity'::date");
  expect(rendered).not.toContain("blended_rank");
});

test("a newest cursor resumes on the rank the page was sorted by", () => {
  const rendered = compile(
    decisionSearchCursorAfterSql({
      sort: "newest",
      position: { band: "undated", id: createSafeId<"caseLawDecision">() },
    }),
  );

  expect(rendered).toStartWith("(m.sort_key, m.decision_id) < (");
  expect(rendered).toContain("'-infinity'::date");
});
