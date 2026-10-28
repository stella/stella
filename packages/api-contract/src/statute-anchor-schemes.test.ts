import { describe, expect, test } from "bun:test";

import {
  E_SBIRKA_ANCHORS,
  SLOV_LEX_ANCHORS,
  US_CODE_ANCHORS,
} from "@stll/legal-ast/statute-anchor-scheme";

import { PUBLIC_LEGISLATION_PAGE_COUNTRIES } from "./legislation-publication";
import { PUBLIC_COUNTRIES } from "./public-country-capability";
import {
  STATUTE_ANCHOR_SCHEMES,
  statuteAnchorSchemeFor,
} from "./statute-anchor-schemes";

describe("statute anchor schemes", () => {
  test("every public country declares one, and nothing else does", () => {
    expect(Object.keys(STATUTE_ANCHOR_SCHEMES).toSorted()).toEqual(
      [...PUBLIC_COUNTRIES].toSorted(),
    );
  });

  test("a country whose statute pages are served reads its publisher's lists", () => {
    for (const country of PUBLIC_LEGISLATION_PAGE_COUNTRIES) {
      expect({ country, type: STATUTE_ANCHOR_SCHEMES[country].type }).toEqual({
        country,
        type: "listed",
      });
    }
  });

  test("each publisher keeps its own grammar, whatever case the code is stored in", () => {
    expect(statuteAnchorSchemeFor("CZE")).toBe(E_SBIRKA_ANCHORS);
    expect(statuteAnchorSchemeFor("svk")).toBe(SLOV_LEX_ANCHORS);
    expect(statuteAnchorSchemeFor(" usa ")).toBe(US_CODE_ANCHORS);
  });

  test("case and surrounding whitespace preserve every public jurisdiction's scheme", () => {
    for (const country of PUBLIC_COUNTRIES) {
      expect(statuteAnchorSchemeFor(` ${country.toLowerCase()} `)).toBe(
        STATUTE_ANCHOR_SCHEMES[country],
      );
    }
  });

  test("a country outside the public list is a bug, not a statute read whole", () => {
    expect(() => statuteAnchorSchemeFor("cz")).toThrow(
      'No statute anchor scheme for country "cz".',
    );
  });
});
