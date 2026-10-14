import { describe, expect, test } from "bun:test";

import {
  isQuestionLike,
  refineOutcome,
  shouldAutoRewrite,
} from "@/features/case-law/case-law-empty-results.logic";
import {
  STRICT_SEARCH_VALUE,
  withAutoRewrite,
  withOriginalWords,
  withQuery,
} from "@/features/case-law/case-law-index-search.logic";

describe("a question, as opposed to the words a reader meant", () => {
  test.each([
    "kdy je možné pro opilost vyhodit zaměstnance?",
    "výpověď opilost?",
    "متى يجوز الفصل؟",
    "when can an employer dismiss",
  ])("%p is a question", (query) => {
    expect(isQuestionLike(query)).toBe(true);
  });

  test.each([
    "",
    "  ",
    "21 Cdo 1234/2020",
    "okamžité zrušení",
    "ECLI:CZ:NS:2020:21.CDO.1",
  ])("%p is not", (query) => {
    expect(isQuestionLike(query)).toBe(false);
  });
});

describe("rewriting a search by itself", () => {
  const EMPTY_QUESTION = {
    isTextSearch: true,
    query: "kdy je možné pro opilost vyhodit zaměstnance?",
    resultCount: 0,
    rowsAnswerQuery: true,
    rewrittenFrom: undefined,
    rewriteOff: false,
  };

  test("a question that found nothing is rewritten once", () => {
    expect(shouldAutoRewrite(EMPTY_QUESTION)).toBe(true);
  });

  test.each([
    ["it found something", { resultCount: 3 }],
    ["the rows still answer the last search", { rowsAnswerQuery: false }],
    ["it is a browse or a lookup", { isTextSearch: false }],
    ["it is already a rewrite", { rewrittenFrom: "the original words" }],
    ["the reader went back to their own words", { rewriteOff: true }],
    ["it is not a question", { query: "okamžité zrušení" }],
  ])("not when %s", (_reason, change) => {
    expect(shouldAutoRewrite({ ...EMPTY_QUESTION, ...change })).toBe(false);
  });
});

describe("a rewrite that lands", () => {
  const ASKED = { country: "cze", entry: "kauce nájem", automatic: false };
  const CURRENT = { country: "cze", query: "kauce nájem " };

  test("searches when the box still holds what was asked", () => {
    expect(
      refineOutcome({ asked: ASKED, current: CURRENT, refined: "jistota" }),
    ).toBe("manual");
    expect(
      refineOutcome({
        asked: { ...ASKED, automatic: true },
        current: CURRENT,
        refined: "jistota",
      }),
    ).toBe("automatic");
  });

  test.each([
    ["the reader typed on", { ...CURRENT, query: "kauce nájem byt" }],
    ["the reader switched jurisdiction", { ...CURRENT, country: "svk" }],
  ])("is dropped when %s before it landed", (_reason, current) => {
    expect(refineOutcome({ asked: ASKED, current, refined: "jistota" })).toBe(
      "stale",
    );
  });

  test("the same words again search nothing new", () => {
    expect(
      refineOutcome({
        asked: ASKED,
        current: CURRENT,
        refined: " kauce nájem",
      }),
    ).toBe("unchanged");
  });
});

describe("the address of a rewrite", () => {
  const ORIGINAL = "kdy je možné pro opilost vyhodit zaměstnance?";
  const REWRITTEN = "okamžité zrušení pracovního poměru opilost";

  test("carries the reader's words beside the rewrite, and back again once", () => {
    const rewritten = withAutoRewrite(
      { country: "cze", q: ORIGINAL, strict: STRICT_SEARCH_VALUE },
      REWRITTEN,
      ORIGINAL,
    );
    expect(rewritten).toMatchObject({
      country: "cze",
      q: REWRITTEN,
      rewrittenFrom: ORIGINAL,
      strict: undefined,
    });
    expect(withOriginalWords(rewritten)).toMatchObject({
      country: "cze",
      q: ORIGINAL,
      rewrittenFrom: undefined,
      rewrite: "off",
    });
  });

  test("a query the reader types drops both", () => {
    expect(
      withQuery(
        { q: REWRITTEN, rewrittenFrom: ORIGINAL, rewrite: "off" },
        "jiná slova",
      ),
    ).toMatchObject({
      q: "jiná slova",
      rewrittenFrom: undefined,
      rewrite: undefined,
    });
  });

  test("going back is a no-op where nothing was rewritten", () => {
    const search = { q: ORIGINAL };
    expect(withOriginalWords(search)).toBe(search);
  });
});
