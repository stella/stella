import { describe, expect, test } from "bun:test";

import {
  CASE_LAW_SEARCH_WARNING_CODES,
  type CaseLawSearchWarning,
  type CaseLawSearchWarningCode,
} from "@stll/api-contract/search";

import { caseLawWarningSurfaces } from "@/features/case-law/search-warnings.logic";

/**
 * The wire's own sentences, which the page must never draw: every assertion
 * below is about the keys the code picked, so a message leaking through would
 * show up as one of these strings.
 */
const warning = (code: CaseLawSearchWarningCode): CaseLawSearchWarning => ({
  code,
  message: `wire message for ${code}`,
  hint: `wire hint for ${code}`,
});

const answered = (...codes: CaseLawSearchWarningCode[]) => ({
  queryUsed: "výpověď z nájmu",
  warnings: codes.map(warning),
});

describe("which warning drives the line above the results", () => {
  test("a query the search widened names what it required", () => {
    const { resultsLine } = caseLawWarningSurfaces(
      answered("function_words_optional"),
    );

    expect(resultsLine).toEqual({
      surface: "resultsLine",
      messageKey: "caseLaw.searchWarnings.resultsFor",
      actionKey: "caseLaw.searchWarnings.searchEveryWord",
      query: "výpověď z nájmu",
    });
  });

  test("a search that required every word draws no line", () => {
    expect(caseLawWarningSurfaces(answered()).resultsLine).toBeNull();
    expect(caseLawWarningSurfaces(answered("no_hits")).resultsLine).toBeNull();
  });

  test("a listing answers no query, so it has nothing to report", () => {
    expect(caseLawWarningSurfaces(null)).toEqual({
      emptyState: null,
      resultsLine: null,
    });
  });
});

describe("which warning drives the empty table", () => {
  test("nothing matched the words the search required", () => {
    const { emptyState } = caseLawWarningSurfaces(answered("no_hits"));

    expect(emptyState).toEqual({
      surface: "emptyState",
      messageKey: "caseLaw.searchWarnings.noHits.message",
      hintKey: "caseLaw.searchWarnings.noHits.hint",
    });
  });

  test("the filters are named as the reading the reader can undo", () => {
    const { emptyState } = caseLawWarningSurfaces(answered("no_hits_filtered"));

    expect(emptyState).toEqual({
      surface: "emptyState",
      messageKey: "caseLaw.searchWarnings.noHitsFiltered.message",
      hintKey: "caseLaw.searchWarnings.noHitsFiltered.hint",
    });
  });

  test("the two empty readings stay distinct", () => {
    const nothing = caseLawWarningSurfaces(answered("no_hits")).emptyState;
    const filtered = caseLawWarningSurfaces(
      answered("no_hits_filtered"),
    ).emptyState;

    expect(nothing?.messageKey).not.toBe(filtered?.messageKey);
    expect(nothing?.hintKey).not.toBe(filtered?.hintKey);
  });

  test("results stand in the table, so they leave it to its own line", () => {
    expect(
      caseLawWarningSurfaces(answered("function_words_optional")).emptyState,
    ).toBeNull();
  });

  test("a widened query that found nothing reaches both regions", () => {
    const surfaces = caseLawWarningSurfaces(
      answered("function_words_optional", "no_hits_filtered"),
    );

    expect(surfaces.resultsLine?.query).toBe("výpověď z nájmu");
    expect(surfaces.emptyState?.messageKey).toBe(
      "caseLaw.searchWarnings.noHitsFiltered.message",
    );
  });
});

describe("the census over the contract's codes", () => {
  test("every code reaches exactly one region", () => {
    for (const code of CASE_LAW_SEARCH_WARNING_CODES) {
      const { emptyState, resultsLine } = caseLawWarningSurfaces(
        answered(code),
      );
      expect(
        [emptyState, resultsLine].filter((it) => it !== null),
      ).toHaveLength(1);
    }
  });

  test("no region renders the wire's own English wording", () => {
    const rendered = JSON.stringify(
      CASE_LAW_SEARCH_WARNING_CODES.map((code) =>
        caseLawWarningSurfaces(answered(code)),
      ),
    );

    expect(rendered).not.toInclude("wire message");
    expect(rendered).not.toInclude("wire hint");
  });
});
