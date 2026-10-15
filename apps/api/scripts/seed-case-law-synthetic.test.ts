import { describe, expect, test } from "bun:test";

import { DECISION_TEXT_FIELD } from "@stll/api-contract/case-law-text-field";
import { PUBLIC_LAW_PAGE_SIZES } from "@stll/api-contract/limits";

import {
  SYNTHETIC_CASE_LAW_QUERY,
  syntheticCaseLawFixtures,
} from "./seed-case-law-synthetic";

const SMALLEST_PAGE_SIZE = Math.min(...PUBLIC_LAW_PAGE_SIZES);
/** Characters past which a headnote wraps in the results table. */
const WRAPPING_HEADNOTE_CHARS = 240;

const decisionsOf = (country: keyof typeof SYNTHETIC_CASE_LAW_QUERY) =>
  syntheticCaseLawFixtures().flatMap(({ decisions }) =>
    decisions.filter((decision) => decision.country === country),
  );

describe("the synthetic case-law fixture", () => {
  test("is the same on every call, so seeded ids stay stable", () => {
    expect(syntheticCaseLawFixtures()).toEqual(syntheticCaseLawFixtures());
  });

  test("fills at least three Czech result pages at the smallest page size", () => {
    expect(decisionsOf("CZE").length).toBeGreaterThan(2 * SMALLEST_PAGE_SIZE);
    expect(decisionsOf("SVK").length).toBeGreaterThan(0);
  });

  test("puts every decision behind its jurisdiction's sample query", () => {
    for (const country of ["CZE", "SVK"] as const) {
      for (const decision of decisionsOf(country)) {
        expect(decision.fulltext).toContain(SYNTHETIC_CASE_LAW_QUERY[country]);
      }
    }
  });

  test("keeps one decision per source, case number and language", () => {
    for (const { decisions } of syntheticCaseLawFixtures()) {
      const keys = decisions.map(
        ({ case_number, language }) => `${case_number}\u0000${language}`,
      );
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  test("spreads the Czech decisions over several courts, years and types", () => {
    const czech = decisionsOf("CZE");
    expect(new Set(czech.map(({ court }) => court)).size).toBeGreaterThan(2);
    expect(
      new Set(czech.map(({ decision_date }) => decision_date?.slice(0, 4)))
        .size,
    ).toBeGreaterThan(2);
    expect(
      new Set(czech.map(({ decision_type }) => decision_type)).size,
    ).toBeGreaterThan(1);
  });

  test("mixes wrapping headnotes, short ones and keyword-only rows", () => {
    const headnotes = decisionsOf("CZE").map(
      ({ metadata }) => metadata?.[DECISION_TEXT_FIELD.LEGAL_SENTENCE],
    );
    const lengths = headnotes
      .filter((headnote) => typeof headnote === "string")
      .map((headnote) => headnote.length);
    expect(lengths.some((length) => length > WRAPPING_HEADNOTE_CHARS)).toBe(
      true,
    );
    expect(lengths.some((length) => length <= WRAPPING_HEADNOTE_CHARS)).toBe(
      true,
    );
    expect(headnotes.some((headnote) => headnote === undefined)).toBe(true);
  });

  test("invents its identifiers and links nowhere", () => {
    for (const { source, decisions } of syntheticCaseLawFixtures()) {
      expect(source.descriptor?.allowsRedistribution).toBe(true);
      for (const decision of decisions) {
        expect(decision.case_number).toStartWith("DEMO ");
        expect(decision.ecli).toBeNull();
        expect(decision.source_url).toBeNull();
        expect(decision.document_url).toBeNull();
      }
    }
  });
});
