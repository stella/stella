import { describe, expect, test } from "bun:test";

import {
  appendDecisionsPage,
  CASE_LAW_COUNTRIES,
  countryLabel,
  defaultCaseLawCountry,
  headnoteText,
} from "./case-law";
import type { DecisionSummary } from "./case-law";

describe("defaultCaseLawCountry", () => {
  test("starts a reader in their language's jurisdiction", () => {
    expect<string>(defaultCaseLawCountry("cs")).toBe("CZE");
    expect<string>(defaultCaseLawCountry("sk")).toBe("SVK");
  });

  test("falls back to the first public jurisdiction", () => {
    expect(defaultCaseLawCountry("de")).toBe(CASE_LAW_COUNTRIES[0] ?? "CZE");
  });
});

describe("headnoteText", () => {
  test("reads a written headnote and a keyword filing", () => {
    expect(headnoteText({ type: "present", text: " Held. " })).toBe("Held.");
    expect(
      headnoteText({
        type: "keywords",
        items: ["Volby", "Ústava"],
        omitted: 0,
      }),
    ).toBe("Volby · Ústava");
  });

  test("shows nothing for an absent or unknown headnote", () => {
    expect(headnoteText({ type: "absent", reason: "not_published" })).toBe(
      null,
    );
    expect(headnoteText(undefined)).toBe(null);
  });
});

test("a next page adds only decisions not already shown", () => {
  const decision = (id: string): DecisionSummary => ({
    id,
    caseNumber: id,
    court: "ÚS",
    decisionDate: null,
    decisionType: null,
    preview: null,
  });
  expect(
    appendDecisionsPage(
      [decision("a"), decision("b")],
      [decision("b"), decision("c")],
    ).map((d) => d.id),
  ).toEqual(["a", "b", "c"]);
});

test("every public jurisdiction has a flag label", () => {
  for (const country of CASE_LAW_COUNTRIES) {
    expect(countryLabel(country)).not.toBe(country);
  }
});
