import { expect, test } from "bun:test";

import {
  type CorpusSearchOrder,
  corpusEngineSortBy,
  RELEVANCE_ORDER,
  SEARCH_SORTS,
} from "@/api/lib/legal-search/corpus-search-order";

const NEWEST: CorpusSearchOrder = {
  type: "newest",
  timestampField: "decision_date_ts",
};

/**
 * The exact strings, pinned, because the engine's spelling is the opposite of
 * what a reader expects and a plausible-looking `-` reverses the page.
 *
 * Measured on the served generation over a band holding both pre-1970 and
 * 2024 decisions: `decision_date_ts` and `+decision_date_ts` both answer with
 * the 2024 decision first, `-decision_date_ts` with the pre-1970 one. So the
 * bare field name is DESCENDING. `-decision_date_ts` shipped once and opened
 * "newest" on 1994.
 */
test("newest asks for the bare timestamp field, which the engine reads as descending", () => {
  expect(corpusEngineSortBy(NEWEST)).toBe("decision_date_ts");
  expect(corpusEngineSortBy(NEWEST)).not.toStartWith("-");
});

// The same unprefixed form, which is why the scan's candidates have always
// arrived best-first: the early-stop proof reads a strictly decreasing rank.
test("relevance asks for the score in that same descending form", () => {
  expect(corpusEngineSortBy(RELEVANCE_ORDER)).toBe("_score");
});

test("every declared order has an engine spelling", () => {
  for (const sort of SEARCH_SORTS) {
    const order: CorpusSearchOrder =
      sort === "newest" ? NEWEST : RELEVANCE_ORDER;
    expect(corpusEngineSortBy(order)).not.toBe("");
  }
});
