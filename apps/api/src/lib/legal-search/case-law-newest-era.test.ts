import { expect, test } from "bun:test";

import {
  CASE_LAW_NEWEST_ERA_CLAUSE,
  withCaseLawNewestEra,
} from "@/api/lib/legal-search/case-law-newest-era";
import { SEARCH_SORTS } from "@/api/lib/legal-search/corpus-search-order";

const QUERY = "jurisdiction:CZE AND text:škoda";

/**
 * The clause verified against the served generation. Its exact shape is the
 * contract, not an implementation detail:
 *
 *  - `decision_date`, not `decision_date_ts`: the projection writes the
 *    timestamp on every document, standing in for a missing date with a
 *    sentinel, so a clause over it cannot tell a dated decision from an
 *    undated one. Range queries on it also came back nonsense live (1,520 of
 *    123,154 matching passages for a 1900-2100 band).
 *  - Closed bounds, because the doc mapping sets `index_field_presence:
 *    false`: an open range matches every document, the absent field included,
 *    and there is no existence query to ask instead.
 *  - The floor is the epoch rather than the sentinel, because the engine's
 *    descending sort orders a negative epoch above every positive one.
 */
test("the newest era is a closed range over the decision's own date", () => {
  expect(CASE_LAW_NEWEST_ERA_CLAUSE).toBe(
    "decision_date:[1970-01-01T00:00:00Z TO 2100-01-01T00:00:00Z]",
  );
});

test("a newest query carries the era clause; a relevance query does not", () => {
  expect(withCaseLawNewestEra(QUERY, "newest")).toBe(
    `(${QUERY}) AND ${CASE_LAW_NEWEST_ERA_CLAUSE}`,
  );
  expect(withCaseLawNewestEra(QUERY, "relevance")).toBe(QUERY);
});

// The narrowing is a conjunction over the whole query, not an extra clause
// beside its last term: `a OR b AND era` would keep every `a`.
test("the era narrows the whole query, not its last term", () => {
  expect(withCaseLawNewestEra("text:a OR text:b", "newest")).toBe(
    `(text:a OR text:b) AND ${CASE_LAW_NEWEST_ERA_CLAUSE}`,
  );
});

test("every declared order says what it does with the era", () => {
  for (const sort of SEARCH_SORTS) {
    expect(() => withCaseLawNewestEra(QUERY, sort)).not.toThrow();
  }
});
