import { expect, test } from "bun:test";
import fc from "fast-check";

import { distance } from "@stll/fuzzy-search";
import { assertProperty } from "@stll/property-testing";

import { deletionKey } from "./deletion-keys";
import type { SanctionsEntry } from "./entry";
import { buildNameIndex, similarStrings } from "./name-match";

const word = fc
  .array(fc.constantFrom(...Array.from("abcdeéčž𐐨")), {
    minLength: 1,
    maxLength: 12,
  })
  .map((characters) => characters.join(""));

const entry = (name: string): SanctionsEntry => ({
  source: "eu",
  issuer: "EU",
  sourceId: name,
  referenceNumber: null,
  entityType: "person",
  names: [{ name, quality: "strong" }],
  birthDates: [],
  nationalities: [],
  identifiers: [],
  addresses: [],
  programme: null,
  legalBasis: null,
  listedOn: null,
  sourceUrl: "https://example.com/list",
});

// The oracle walks the actual vocabulary, including joined and folded forms;
// it shares only the documented distance contract with the indexed lookup.
test("deletion neighbours equal brute force for every vocabulary spelling", () => {
  assertProperty(
    "deletion neighbours equal brute force for every vocabulary spelling",
    fc.property(
      fc.array(word, { minLength: 1, maxLength: 50 }),
      word,
      (words, query) => {
        const index = buildNameIndex(words.map(entry));
        const transposed = Array.from(query);
        const first = transposed.at(0);
        const second = transposed.at(1);
        if (first !== undefined && second !== undefined) {
          transposed[0] = second;
          transposed[1] = first;
        }
        for (const vocabulary of [index.raw, index.folded]) {
          for (const text of [
            query,
            transposed.join(""),
            ...words.slice(0, 2),
          ]) {
            const expected = new Map<number, number>();
            for (let id = 0; id < vocabulary.strings.length; id += 1) {
              const candidate = vocabulary.strings.get(id);
              const shorter = Math.min(
                Array.from(text).length,
                Array.from(candidate).length,
              );
              let budget = 0;
              if (shorter >= 4) {
                budget = shorter < 6 ? 1 : 2;
              }
              const edits = distance(text, candidate, "damerau-levenshtein");
              if (edits <= budget) {
                expected.set(
                  id,
                  1 -
                    edits /
                      Math.max(
                        Array.from(text).length,
                        Array.from(candidate).length,
                      ),
                );
              }
            }
            const work = {
              remaining: Number.MAX_SAFE_INTEGER,
              exhausted: false,
            };
            const actual = similarStrings({ vocabulary, text, work });
            expect(work.exhausted).toBe(false);
            expect([...actual].toSorted(([a], [b]) => a - b)).toEqual([
              ...expected,
            ]);
          }
        }
      },
    ),
  );
});

test("every dense neighbour is verified beyond the former candidate cap", () => {
  const words = Array.from("abcdefghijklmnopqrst").flatMap((first) =>
    Array.from("abcdefghijklmnopqrst").map(
      (second) => `novak${first}${second}`,
    ),
  );
  const index = buildNameIndex(words.map(entry));
  const work = { remaining: Number.MAX_SAFE_INTEGER, exhausted: false };
  const actual = similarStrings({
    vocabulary: index.raw,
    text: "novaka",
    work,
  });
  expect(actual.size).toBe(400);
  expect(work.exhausted).toBe(false);
});

test("delete-key hash collisions cannot admit an out-of-budget spelling", () => {
  const index = buildNameIndex([entry("novak")]);
  const list = index.raw.deletes.get(deletionKey("novak"));
  expect(list).toBeDefined();
  const vocabulary = { ...index.raw, deletes: { get: () => list } };
  const work = { remaining: Number.MAX_SAFE_INTEGER, exhausted: false };
  expect(similarStrings({ vocabulary, text: "abcde", work }).size).toBe(0);
  expect(work.exhausted).toBe(false);
});
