import { describe, expect, test } from "bun:test";

import { PUBLIC_COUNTRIES } from "./public-country-capability";
import { STATUTE_ACTS } from "./statute-acts";
import { STATUTE_ALIASES } from "./statute-aliases";
import { statuteGazetteAbbreviation } from "./statute-gazette";
import {
  STATUTE_QUERY_CAPABILITIES,
  readStatuteQueryScope,
} from "./statute-query-capability";
import { parseStatuteQuery } from "./statute-query-intent";

const publicCountries = PUBLIC_COUNTRIES.map((country) =>
  country.toLowerCase(),
);

describe("statute query capability", () => {
  test("classifies exactly the public countries", () => {
    expect(Object.keys(STATUTE_QUERY_CAPABILITIES).toSorted()).toEqual(
      publicCountries.toSorted(),
    );
  });

  test.each(publicCountries)(
    "%s is either fully readable or explicitly unsupported",
    (code) => {
      const scope = readStatuteQueryScope(code);
      switch (scope.type) {
        case "supported": {
          const { country } = scope;
          const { defaultCollection } = STATUTE_QUERY_CAPABILITIES[country];
          expect(Object.keys(STATUTE_ALIASES[country]).length).toBeGreaterThan(
            0,
          );
          expect(Object.keys(STATUTE_ACTS[country]).length).toBeGreaterThan(0);
          expect(
            statuteGazetteAbbreviation(defaultCollection, 2000),
          ).not.toBeNull();
          expect(parseStatuteQuery(country, "57/2000")).toMatchObject({
            type: "act",
            collection: defaultCollection,
          });
          break;
        }
        case "unsupported":
          expect(scope.reason).toBe("no_query_grammar");
          break;
        default:
          scope satisfies never;
      }
    },
  );

  test.each(["", "xaa", "CZE", "constructor", "__proto__"])(
    "%p is not a country the statute box knows",
    (code) => {
      expect(readStatuteQueryScope(code)).toEqual({
        type: "unsupported",
        reason: "unknown_country",
      });
    },
  );
});
