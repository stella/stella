import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { distance } from "@stll/fuzzy-search";
import {
  assertProperty,
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";
import { normalizeUnicode, stripUnicodeMarks } from "@stll/text-normalize";

import type { AliasQuality, SanctionsEntry } from "./entry";
import { buildNameIndex, matchNames } from "./name-match";
import { nameReading, nameTokens } from "./normalise";

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
    .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), {
      minLength: 2,
      maxLength: 10,
    })
    .map((letters) => letters.join("")),
);
const words = fc.array(word, { minLength: 1, maxLength: 4 });
// Inflected, transcribed and joined spellings of shared stems, so generated
// queries land within edit budgets of many listed tokens at once.
const inflectedWord = fc.constantFrom(
  "Novák",
  "Nováková",
  "Novákovi",
  "Novakem",
  "Nowak",
  "Dvořák",
  "Dvořáková",
  "Dvorak",
  "Mohammed",
  "Muhammad",
  "Mokhammed",
  "Abdul",
  "Rahman",
  "Abdulrahman",
  "Ivanov",
  "Ivanova",
  "Ivanovich",
  "Iwanow",
  "Ali",
  "Al",
  "Müller",
  "Mueller",
  "Smith",
  "Smiht",
);
const inflectedName = fc
  .array(inflectedWord, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join(" "));
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

const matchesFor = (
  index: ReturnType<typeof buildNameIndex>,
  query: string,
  tau = 0,
) => {
  const result = matchNames({
    index,
    reading: nameReading(query, "person"),
    tau,
    work: { remaining: Number.MAX_SAFE_INTEGER, exhausted: false },
  });
  if (result === undefined) {
    panic("Small generated names exceeded the screening work budget");
  }
  return result.matches;
};

const scores = (index: ReturnType<typeof buildNameIndex>, query: string) =>
  [...matchesFor(index, query)]
    .map(([entryIndex, match]) => ({ entry: entryIndex, score: match.score }))
    .toSorted((left, right) => left.entry - right.entry);

const score = (listed: string, query: string) =>
  matchesFor(buildNameIndex([entry(listed)]), query).get(0)?.score ?? 0;

describe("name matching (properties)", () => {
  test("matches raw and folded spellings of a listed name", () => {
    const accentedIndex = buildNameIndex([entry("José Mikhailovich")]);
    expect(accentedIndex.raw.strings.get(1)).toBe("mikhailovich");
    expect(accentedIndex.folded.strings.get(1)).not.toBe("mikhailovich");
    expect(matchesFor(accentedIndex, "José Mikhailovich").get(0)?.score).toBe(
      1,
    );
    expect(
      matchesFor(accentedIndex, "Jose Michajlovic").get(0)?.score,
    ).toBeGreaterThan(0);
  });

  test("keeps supplementary-plane letters in spelling lookups", () => {
    const index = buildNameIndex([entry("𐐨obert Smith")]);
    expect(matchesFor(index, "𐐨obert Smith").get(0)?.score).toBe(1);
    expect(matchesFor(index, "𐐨obertt Smith").get(0)?.score).toBeGreaterThan(0);
  });

  test(
    "matches every generated strong name with full coverage",
    () => {
      fc.assert(
        fc.property(
          fc.array(fullName, { minLength: 1, maxLength: 5 }),
          (names) => {
            const index = buildNameIndex(names.map((value) => entry(value)));
            for (const [position, value] of names.entries()) {
              const matches = matchesFor(index, value);
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
              stripUnicodeMarks(value, { form: "NFD", markClass: "combining" });
            expect(normalizeUnicode(query, "NFD")).not.toBe(query);
            expect(strip(query)).not.toBe(query);
            const index = buildNameIndex(names.map((value) => entry(value)));
            for (const transform of [
              (value: string) => normalizeUnicode(value, "NFD"),
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
          word
            .chain((left) =>
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
            )
            .filter((pair) =>
              pair.every(
                (value) =>
                  (nameTokens(value, "person").at(0)?.raw.length ?? 0) > 1,
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
    "initials-only queries remain unanchored",
    () => {
      fc.assert(
        fc.property(words, (parts) => {
          const listed = parts.join(" ");
          const index = buildNameIndex([entry(listed)]);
          const tokens = nameTokens(listed, "person");
          const initialsQuery = tokens
            .map(({ raw }) => raw.charAt(0))
            .join(".");
          const initials = nameTokens(initialsQuery, "person");
          expect(initials.length).toBeGreaterThan(0);
          expect(initials.every(({ raw }) => raw.length === 1)).toBe(true);
          expect(matchesFor(index, listed).get(0)?.score).toBe(1);
          expect(matchesFor(index, initialsQuery).size).toBe(0);
        }),
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

  test(
    "lexicon lookups equal a brute-force edit-distance scan of each form",
    () => {
      assertProperty(
        "lexicon lookups equal a brute-force edit-distance scan of each form",
        fc.property(
          fc.array(inflectedName, { minLength: 1, maxLength: 12 }),
          inflectedName,
          (names, query) => {
            const index = buildNameIndex(names.map((value) => entry(value)));
            const texts = new Set([
              ...nameTokens(query, "person").flatMap(({ raw, folded }) => [
                raw,
                folded,
              ]),
              ...names.flatMap((value) =>
                nameTokens(value, "person").map(({ raw }) => raw),
              ),
            ]);
            for (const text of texts) {
              const found = index.candidates.search(
                {
                  tokens: [{ form: 0, text, weight: 1 }],
                  units: [0, 1].map((form) => ({
                    form,
                    text,
                    positions: [0],
                  })),
                },
                { tau: 2, quality: 1, maxCost: Number.MAX_SAFE_INTEGER },
              );
              expect(found.exhausted).toBe(false);
              for (const [form, vocabulary] of [
                index.folded,
                index.raw,
              ].entries()) {
                const actual = new Map<number, number>();
                for (
                  let match = 0;
                  match < found.similarities.length;
                  match++
                ) {
                  if (found.matchKeys[match * 3] === form) {
                    actual.set(
                      found.matchKeys[match * 3 + 2] ?? panic("Missing id"),
                      found.similarities[match] ?? panic("Missing score"),
                    );
                  }
                }
                const expected = new Map<number, number>();
                for (let id = 0; id < vocabulary.strings.length; id += 1) {
                  const candidate = vocabulary.strings.get(id);
                  const lengths = [text, candidate].map(
                    (value) => Array.from(value).length,
                  );
                  const shorter = Math.min(...lengths);
                  let budget = 0;
                  if (shorter >= 4) {
                    budget = shorter <= 5 ? 1 : 2;
                  }
                  const edits = distance(
                    text,
                    candidate,
                    "damerau-levenshtein",
                  );
                  if (edits <= budget) {
                    expected.set(id, 1 - edits / Math.max(...lengths));
                  }
                }
                expect([...actual.keys()].toSorted((a, b) => a - b)).toEqual(
                  [...expected.keys()].toSorted((a, b) => a - b),
                );
                for (const [id, similarity] of expected) {
                  expect(actual.get(id)).toBeCloseTo(similarity, 12);
                }
              }
            }
          },
        ),
      );
    },
    propertyTestTimeout(10_000),
  );

  test(
    "candidates keep every alias whose score reaches the name-score floor",
    () => {
      assertProperty(
        "candidates keep every alias whose score reaches the name-score floor",
        fc.property(
          fc.array(
            fc.tuple(
              fc.array(inflectedName, { minLength: 1, maxLength: 3 }),
              fc.constantFrom<AliasQuality>("strong", "weak", "unknown"),
            ),
            { minLength: 1, maxLength: 20 },
          ),
          fc.oneof(inflectedName, fc.constantFrom("A. Novák", "J Smith")),
          (listed, query) => {
            const index = buildNameIndex(
              listed.map(([names, quality], position) => ({
                ...entry(names.at(0) ?? panic("Missing generated name")),
                sourceId: String(position),
                names: names.map((name) => ({ name, quality })),
              })),
            );
            // At a zero floor the index returns every alias, and its lookups
            // equal brute force (above), so this is exhaustive scoring.
            const all = index.candidates.search(
              {
                tokens: [{ form: 0, text: "x", weight: 1 }],
                units: [],
              },
              { tau: 0, quality: 1, maxCost: Number.MAX_SAFE_INTEGER },
            );
            expect(all.survivors.length).toBe(index.aliases.length);
            const oracle = matchesFor(index, query, 0);
            // Each score is the tightest floor at which its entry must stay.
            for (const tau of new Set(
              [...oracle.values()].map((match) => match.score),
            )) {
              const actual = matchesFor(index, query, tau);
              for (const [entryIndex, match] of oracle) {
                if (match.score >= tau) {
                  expect(actual.get(entryIndex)).toEqual(match);
                }
              }
              // Below the floor only a lower-scoring alias may remain.
              for (const [entryIndex, match] of actual) {
                const best = oracle.get(entryIndex);
                if (match.score >= tau) {
                  expect(best).toEqual(match);
                } else {
                  expect(match.score).toBeLessThanOrEqual(best?.score ?? 0);
                }
              }
            }
          },
        ),
      );
    },
    propertyTestTimeout(10_000),
  );
});
