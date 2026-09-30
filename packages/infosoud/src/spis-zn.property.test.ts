import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  formatSpisZnCanonical,
  formatSpisZnCompact,
  parseSpisZn,
} from "./spis-zn.js";

const caseNumber = fc.record({
  cisloSenatu: fc.integer({ min: 1, max: 999 }),
  druhVeci: fc.constantFrom("T", "C", "Cdo", "Tdo", "ICdo", "Co", "Nc"),
  bcVec: fc.integer({ min: 1, max: 999_999 }),
  rocnik: fc.integer({ min: 1000, max: 9999 }),
});
const spacing = fc.constantFrom(" ", "  ", "\t", "\n", "\u00a0", "\u202f");

test(
  "case-number spellings retain their canonical identity",
  () => {
    fc.assert(
      fc.property(
        caseNumber,
        spacing,
        fc.constantFrom("/", "_", " "),
        (parts, gap, separator) => {
          const canonical = formatSpisZnCanonical(parts);
          const parsed = parseSpisZn(canonical);
          expect(parsed).toMatchObject({
            ...parts,
            druhVeci: parts.druhVeci.toUpperCase(),
          });
          const spelling = `${gap}${parts.cisloSenatu}${gap}${parts.druhVeci.toLowerCase()}${gap}${parts.bcVec}${separator}${gap}${parts.rocnik}${gap}`;
          expect(parseSpisZn(spelling)).toEqual(parsed);
          expect(parseSpisZn(formatSpisZnCanonical(parsed))).toEqual(parsed);
          expect(parseSpisZn(formatSpisZnCompact(parsed))).toEqual(parsed);
          expect(
            formatSpisZnCanonical(parseSpisZn(formatSpisZnCanonical(parsed))),
          ).toBe(formatSpisZnCanonical(parsed));
        },
      ),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);
