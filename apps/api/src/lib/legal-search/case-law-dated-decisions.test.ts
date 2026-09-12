import { expect, test } from "bun:test";

import {
  CASE_LAW_DATED_DECISION_CLAUSE,
  withCaseLawDatedDecisions,
} from "@/api/lib/legal-search/case-law-dated-decisions";
import { SEARCH_SORTS } from "@/api/lib/legal-search/corpus-search-order";

const QUERY = "jurisdiction:CZE AND text:škoda";

/**
 * The clause verified against the served generation. Its exact shape is the
 * contract, not an implementation detail:
 *
 *  - `decision_date`, not `decision_date_ts`: the projection writes the
 *    timestamp on every document, standing in for a missing date with a
 *    sentinel, so no clause over it can tell a dated decision from an undated
 *    one. Range queries on it also came back nonsense live (1,520 of 123,154
 *    matching passages for a 1900-2100 band).
 *  - Closed bounds, because the doc mapping sets `index_field_presence:
 *    false`: an open range matches every document, the absent field included.
 *  - A floor at the sentinel's own date, which readmits nothing because the
 *    sentinel is never written to this field, and which is the oldest floor
 *    measured to behave: 1500-01-01 and 1000-01-01 both matched zero of nine
 *    million documents instead of failing.
 */
test("the dated-decision clause is a closed range over the decision's date", () => {
  expect(CASE_LAW_DATED_DECISION_CLAUSE).toBe(
    "decision_date:[1800-01-01T00:00:00Z TO 2100-01-01T00:00:00Z]",
  );
});

// A pre-1970 decision is dated like any other, and the engine orders it
// correctly, so `newest` must not cut it off.
test("the clause keeps every century a court has published in", () => {
  expect(CASE_LAW_DATED_DECISION_CLAUSE).not.toContain("1970");
});

test("a newest query carries the clause; a relevance query does not", () => {
  expect(withCaseLawDatedDecisions(QUERY, "newest")).toBe(
    `(${QUERY}) AND ${CASE_LAW_DATED_DECISION_CLAUSE}`,
  );
  expect(withCaseLawDatedDecisions(QUERY, "relevance")).toBe(QUERY);
});

// The narrowing is a conjunction over the whole query, not an extra clause
// beside its last term: `a OR b AND dated` would keep every `a`.
test("the clause narrows the whole query, not its last term", () => {
  expect(withCaseLawDatedDecisions("text:a OR text:b", "newest")).toBe(
    `(text:a OR text:b) AND ${CASE_LAW_DATED_DECISION_CLAUSE}`,
  );
});

test("every declared order says what it does with the clause", () => {
  for (const sort of SEARCH_SORTS) {
    expect(() => withCaseLawDatedDecisions(QUERY, sort)).not.toThrow();
  }
});
