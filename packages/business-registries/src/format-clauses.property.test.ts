import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertySeed } from "@stll/property-testing";

import {
  clausesForTokens,
  formatFromClauses,
  templateForTokens,
} from "./format-clauses.js";
import type { RegistryFormatClause } from "./format-clauses.js";
import {
  nullableRegistryString,
  registryString,
} from "./shared/property-test-helpers.test.js";

test("required particulars resolve only from supplied tokens and preserve fixed clauses", () => {
  fc.assert(
    fc.property(registryString, nullableRegistryString, (token, value) => {
      const fixed = {
        template: "fixed",
        requires: [],
      } satisfies RegistryFormatClause;
      const clauses = [
        fixed,
        { template: "particular", requires: [token], separator: " " },
      ] satisfies RegistryFormatClause[];
      expect(clausesForTokens(clauses, {})).toEqual([fixed]);
      expect(templateForTokens(clauses, {})).toBe("fixed");
      const tokens = { [token]: value };
      const expected = value?.trim() ? clauses : [fixed];
      expect(clausesForTokens(clauses, tokens)).toEqual(expected);
      expect(templateForTokens(clauses, tokens)).toBe(
        formatFromClauses(expected),
      );
      expect(clausesForTokens(expected, tokens)).toEqual(expected);
    }),
    propertyConfig({ seed: propertySeed() }),
  );
});
