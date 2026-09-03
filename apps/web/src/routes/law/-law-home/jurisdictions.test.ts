import { describe, expect, test } from "bun:test";

import { parseDecisionQuery } from "@stll/api-contract/decision-query-intent";

import { parseStatuteQuery } from "@/features/statutes/statute-query-intent";
import { STATUTE_COUNTRIES } from "@/lib/statute-route";
import {
  LAW_HOME_JURISDICTION_CODES,
  LAW_HOME_JURISDICTIONS,
  type LawScope,
  statuteCountryOf,
} from "@/routes/law/-law-home/jurisdictions";

const ALL_SCOPES: readonly LawScope[] = ["decisions", "statutes"];

describe("law home jurisdictions", () => {
  test("every jurisdiction the case-law pill offers has a descriptor", () => {
    expect(LAW_HOME_JURISDICTION_CODES).toEqual(["CZE", "EU", "POL", "SVK"]);
  });

  test("the statutes scope is exactly the statutes browser's coverage", () => {
    const withStatutes: string[] = LAW_HOME_JURISDICTION_CODES.filter((code) =>
      LAW_HOME_JURISDICTIONS[code].scopes.some(
        (scope: LawScope) => scope === "statutes",
      ),
    );
    const browserCountries = Object.keys(STATUTE_COUNTRIES)
      .map((segment) => segment.toUpperCase())
      .sort();

    expect([...withStatutes].sort()).toEqual(browserCountries);
  });

  test("a listed scope has examples and an unlisted one has none", () => {
    for (const code of LAW_HOME_JURISDICTION_CODES) {
      const { examples, scopes } = LAW_HOME_JURISDICTIONS[code];
      for (const scope of ALL_SCOPES) {
        const listed = scopes.some((offered: LawScope) => offered === scope);
        const count = examples[scope].length;

        expect({ code, scope, listed, hasExamples: count > 0 }).toEqual({
          code,
          scope,
          listed,
          hasExamples: listed,
        });
      }
    }
  });

  test("every decision example parses as an identifier", () => {
    for (const code of LAW_HOME_JURISDICTION_CODES) {
      for (const example of LAW_HOME_JURISDICTIONS[code].examples.decisions) {
        expect({ example, type: parseDecisionQuery(example).type }).toEqual({
          example,
          type: "identifier",
        });
      }
    }
  });

  test("every statute example parses as an act reference", () => {
    for (const code of LAW_HOME_JURISDICTION_CODES) {
      const examples = LAW_HOME_JURISDICTIONS[code].examples.statutes;
      if (examples.length === 0) {
        continue;
      }
      const country = statuteCountryOf(code);
      expect(country).not.toBeNull();
      if (country === null) {
        continue;
      }

      for (const example of examples) {
        expect({
          example,
          type: parseStatuteQuery(country, example).type,
        }).toEqual({ example, type: "act" });
      }
    }
  });

  test("statuteCountryOf answers only for jurisdictions the browser covers", () => {
    expect(statuteCountryOf("CZE")).toBe("cze");
    expect(statuteCountryOf("SVK")).toBe("svk");
    expect(statuteCountryOf("POL")).toBeNull();
    expect(statuteCountryOf("EU")).toBeNull();
    expect(statuteCountryOf(undefined)).toBeNull();
  });
});
