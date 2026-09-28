import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { normalizeEli } from "./eli";

const HOSTS = {
  cz: "https://www.e-sbirka.cz",
  sk: "https://www.slov-lex.sk",
  eu: "https://eur-lex.europa.eu",
} as const;

type Work = {
  jurisdiction: keyof typeof HOSTS;
  collection: string;
  year: number;
  number: number;
};

const workArb = fc.record({
  jurisdiction: fc.constantFrom("cz", "sk", "eu" as const),
  collection: fc.stringMatching(/^[a-z]{2,6}$/u),
  year: fc.integer({ min: 1900, max: 2100 }),
  number: fc.integer({ min: 1, max: 9999 }),
});

const canonicalOf = ({ jurisdiction, collection, year, number }: Work) =>
  `${HOSTS[jurisdiction]}/eli/${jurisdiction}/${collection}/${year}/${number}`;

/** Every spelling of one work a model produces, none of them canonical. */
const SPELLINGS = [
  ({ jurisdiction, collection, year, number }: Work) =>
    `/eli/${jurisdiction}/${collection}/${year}/${number}`,
  ({ jurisdiction, collection, year, number }: Work) =>
    `eli/${jurisdiction}/${collection}/${year}/${number}`,
  ({ jurisdiction, collection, year, number }: Work) =>
    `${jurisdiction}/${collection}/${year}/${number}`,
  ({ jurisdiction, collection, year, number }: Work) =>
    `/eli/${jurisdiction.toUpperCase()}/${collection.toUpperCase()}/${year}/${number}`,
  ({ jurisdiction, collection, year, number }: Work) =>
    `https://example.org/eli/${jurisdiction}/${collection}/${year}/${number}/`,
  ({ jurisdiction, collection, year, number }: Work) =>
    `example.org/eli/${jurisdiction}/${collection}/${year}/${number}`,
  (work: Work) => ` ${canonicalOf(work)}/ `,
  ({ jurisdiction, collection, year, number }: Work) =>
    `/eli/${jurisdiction}/${collection}/${number}/${year}`,
] as const;

/** A number that is itself a plausible year leaves the order in doubt. */
const numberIsYear = ({ number }: Work): boolean =>
  number >= 1800 && number <= 2100;

describe("legislation identifiers", () => {
  test("every spelling of a work reads back to its canonical ELI", () => {
    fc.assert(
      fc.property(workArb, fc.constantFrom(...SPELLINGS), (work, spell) => {
        const result = normalizeEli(spell(work), { hosts: HOSTS });
        if (numberIsYear(work)) {
          expect(result.ok).toBe(false);
          expect(!result.ok && result.hint).toContain(canonicalOf(work));
          return;
        }
        expect(result.ok && result.value).toBe(canonicalOf(work));
        expect(result.ok && result.note).toBeString();
      }),
      propertyConfig({ numRuns: 400 }),
    );
  });

  test("a canonical ELI is a fixed point with nothing to report", () => {
    fc.assert(
      fc.property(workArb, (work) => {
        expect(normalizeEli(canonicalOf(work), { hosts: HOSTS })).toEqual({
          ok: true,
          value: canonicalOf(work),
        });
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });
});
