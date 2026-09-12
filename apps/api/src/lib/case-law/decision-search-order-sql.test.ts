import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  decisionSortKeySql,
  UNDATED_DECISION_SORT_KEY,
} from "@/api/lib/case-law/decision-search-order-sql";
import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";

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
 * Nulls last, and the reason the floor is a magic-looking number rather than
 * `-infinity`: the keyset cursor carries this key as a JSON number, and the
 * codec refuses a non-finite one, so an undated decision on a page boundary
 * would make the next page unreachable.
 */
test("an undated decision sorts below every date, and still fits a cursor", () => {
  const earliestRepresentableDate = Date.UTC(-4713, 0, 1) / 1000;

  expect(Number.isFinite(UNDATED_DECISION_SORT_KEY)).toBe(true);
  expect(UNDATED_DECISION_SORT_KEY).toBeLessThan(earliestRepresentableDate);
  expect(
    decodeCursor(encodeCursor(UNDATED_DECISION_SORT_KEY, "decision-id"))?.score,
  ).toBe(UNDATED_DECISION_SORT_KEY);
});
