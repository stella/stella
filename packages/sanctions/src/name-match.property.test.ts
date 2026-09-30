import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import type { AliasQuality, SanctionsEntry } from "./entry";
import { buildNameIndex, matchNames } from "./name-match";
import { nameTokens } from "./normalise";

const config = () => propertyConfig({ seed: propertySeed() });
const word = fc.oneof(
  fc.constantFrom(
    "Čapek",
    "Žák",
    "José",
    "Müller",
    "İpek",
    "François",
    "Dvořák",
    "O’Neil",
    "Łukasz",
    "Søren",
    "محمد",
    "علي",
    "Владимир",
  ),
  fc
    .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), {
      minLength: 2,
      maxLength: 10,
    })
    .map((letters) => letters.join("")),
);
const words = fc.array(word, { minLength: 1, maxLength: 4 });
const fullName = words.map((parts) => parts.join(" "));
const spacing = fc.constantFrom(" ", "  ", "\t", "\n", "\u00a0", "\u2003");

const entry = (
  name: string,
  quality: AliasQuality = "strong",
): SanctionsEntry => ({
  source: "eu",
  issuer: "EU",
  sourceId: "property-entry",
  referenceNumber: null,
  entityType: "person",
  names: [{ name, quality }],
  birthDates: [],
  nationalities: [],
  identifiers: [],
  addresses: [],
  programme: null,
  legalBasis: null,
  listedOn: null,
  sourceUrl: "https://example.com/list",
});

const scores = (index: ReturnType<typeof buildNameIndex>, query: string) =>
  [...matchNames(index, nameTokens(query, "person"), Math.sqrt, 0)]
    .map(([entryIndex, match]) => ({ entry: entryIndex, score: match.score }))
    .toSorted((left, right) => left.entry - right.entry);

const score = (listed: string, query: string) =>
  matchNames(
    buildNameIndex([entry(listed)]),
    nameTokens(query, "person"),
    Math.sqrt,
    0,
  ).get(0)?.score ?? 0;

describe("name matching (properties)", () => {
  test(
    "matches every generated strong name with full coverage",
    () => {
      fc.assert(
        fc.property(
          fc.array(fullName, { minLength: 1, maxLength: 5 }),
          (names) => {
            const index = buildNameIndex(names.map((value) => entry(value)));
            for (const [position, value] of names.entries()) {
              const matches = matchNames(
                index,
                nameTokens(value, "person"),
                Math.sqrt,
                0,
              );
              expect(matches.get(position)?.score).toBe(1);
              for (const match of matches.values()) {
                expect(Number.isFinite(match.score)).toBe(true);
                expect(match.score).toBeGreaterThan(0);
                expect(match.score).toBeLessThanOrEqual(1);
              }
            }
          },
        ),
        config(),
      );
    },
    propertyTestTimeout(5000),
  );

  test(
    "keeps scores when query and list change case or whitespace",
    () => {
      fc.assert(
        fc.property(
          fc.array(fullName, { minLength: 1, maxLength: 5 }),
          fullName,
          spacing,
          (names, query, gap) => {
            const transform = (value: string) =>
              `${gap}${value.toUpperCase().split(" ").join(gap)}${gap}`;
            const index = buildNameIndex(names.map((value) => entry(value)));
            const transformed = buildNameIndex(
              names.map((value) => entry(transform(value))),
            );
            for (const value of [query, ...names]) {
              expect(scores(index, transform(value))).toEqual(
                scores(index, value),
              );
              expect(scores(transformed, value)).toEqual(scores(index, value));
            }
          },
        ),
        config(),
      );
    },
    propertyTestTimeout(5000),
  );

  test(
    "keeps scores under composed, decomposed and unaccented Latin spelling",
    () => {
      const latinWord = fc.constantFrom(
        "Čapek",
        "Žák",
        "José",
        "Müller",
        "İpek",
        "François",
        "Dvořák",
      );
      const latinName = fc
        .array(latinWord, { minLength: 1, maxLength: 4 })
        .map((parts) => parts.join(" "));
      fc.assert(
        fc.property(
          fc.array(latinName, { minLength: 1, maxLength: 5 }),
          latinName,
          (names, query) => {
            const strip = (value: string) =>
              value.normalize("NFD").replaceAll(/\p{M}/gu, "");
            expect(query.normalize("NFD")).not.toBe(query);
            expect(strip(query)).not.toBe(query);
            const index = buildNameIndex(names.map((value) => entry(value)));
            for (const transform of [
              (value: string) => value.normalize("NFD"),
              strip,
            ]) {
              const transformed = buildNameIndex(
                names.map((value) => entry(transform(value))),
              );
              for (const value of [query, ...names]) {
                expect(scores(index, transform(value))).toEqual(
                  scores(index, value),
                );
                expect(scores(transformed, value)).toEqual(
                  scores(index, value),
                );
              }
            }
          },
        ),
        config(),
      );
    },
    propertyTestTimeout(5000),
  );

  test(
    "full-name coverage is independent of token order",
    () => {
      fc.assert(
        fc.property(words, (parts) => {
          const value = parts.join(" ");
          const reversed = parts.toReversed().join(" ");
          expect(score(value, reversed)).toBe(1);
          expect(score(reversed, value)).toBe(1);
        }),
        config(),
      );
    },
    propertyTestTimeout(5000),
  );

  test(
    "single-word strong-name scores are symmetric",
    () => {
      fc.assert(
        fc.property(
          word.chain((left) =>
            fc.tuple(
              fc.constant(left),
              fc.oneof(
                word,
                fc.constantFrom(
                  left,
                  `${left}a`,
                  left.slice(0, -1),
                  left.slice(1) + left.charAt(0),
                ),
              ),
            ),
          ),
          ([left, right]) => {
            expect(score(left, right)).toBeCloseTo(score(right, left), 12);
          },
        ),
        config(),
      );
    },
    propertyTestTimeout(5000),
  );

  test(
    "repeated equivalent aliases preserve the strongest quality",
    () => {
      fc.assert(
        fc.property(fullName, fullName, (listed, query) => {
          const strong = entry(listed);
          const repeated = {
            ...strong,
            names: [
              { name: listed.toUpperCase(), quality: "weak" },
              ...strong.names,
              { name: `  ${listed}  `, quality: "unknown" },
            ],
          } satisfies SanctionsEntry;
          const baseline = buildNameIndex([strong]);
          const duplicate = buildNameIndex([repeated]);
          expect(duplicate.aliases).toHaveLength(1);
          expect(duplicate.weights).toEqual(baseline.weights);
          for (const value of [listed, query]) {
            expect(scores(duplicate, value)).toEqual(scores(baseline, value));
          }
        }),
        config(),
      );
    },
    propertyTestTimeout(5000),
  );
});
