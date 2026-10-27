import { describe, expect, test } from "bun:test";

import {
  E_SBIRKA_LIST_SCHEME,
  SLOV_LEX_LIST_SCHEME,
} from "@stll/legal-ast/statute-list";

import { PUBLIC_LEGISLATION_PAGE_COUNTRIES } from "./legislation-publication";
import { PUBLIC_COUNTRIES } from "./public-country-capability";
import {
  STATUTE_LIST_SCHEMES,
  statuteListSchemeFor,
} from "./statute-list-schemes";

describe("statute list schemes", () => {
  test("every public country declares one, and nothing else does", () => {
    expect(Object.keys(STATUTE_LIST_SCHEMES).toSorted()).toEqual(
      [...PUBLIC_COUNTRIES].toSorted(),
    );
  });

  test("a country whose statute pages are served reads its publisher's lists", () => {
    for (const country of PUBLIC_LEGISLATION_PAGE_COUNTRIES) {
      expect({ country, type: STATUTE_LIST_SCHEMES[country].type }).toEqual({
        country,
        type: "nested",
      });
    }
  });

  test("each publisher keeps its own grammar, whatever case the code is stored in", () => {
    expect(statuteListSchemeFor("CZE")).toBe(E_SBIRKA_LIST_SCHEME);
    expect(statuteListSchemeFor("svk")).toBe(SLOV_LEX_LIST_SCHEME);
    expect(statuteListSchemeFor(" usa ").type).toBe("flat");
  });

  test("case and surrounding whitespace preserve every public jurisdiction's scheme", () => {
    for (const country of PUBLIC_COUNTRIES) {
      expect(statuteListSchemeFor(` ${country.toLowerCase()} `)).toBe(
        STATUTE_LIST_SCHEMES[country],
      );
    }
  });

  test("a country outside the public list is a bug, not a flat statute", () => {
    expect(() => statuteListSchemeFor("cz")).toThrow(
      'No statute list scheme for country "cz".',
    );
  });
});
