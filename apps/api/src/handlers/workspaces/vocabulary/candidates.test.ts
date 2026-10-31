import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  collectVocabulary,
  VOCABULARY_KINDS,
  VOCABULARY_LIMITS,
  VOCABULARY_WEIGHTS,
} from "./candidates";

const kinds = VOCABULARY_KINDS;

const source = fc.record({
  term: fc.oneof(
    fc.string({ maxLength: 600 }),
    fc.constantFrom(
      "Žofia Šťastná",
      "s Ľubošem Říhou",
      "Čučoriedka, s. r. o.",
      " ",
    ),
  ),
  kind: fc.constantFrom(...kinds),
  lastUsedAt: fc.option(
    fc.date({
      min: new Date("2020-01-01"),
      max: new Date("2030-01-01"),
      noInvalidDate: true,
    }),
    { nil: undefined },
  ),
});

test("matter vocabulary preserves source spelling within unique bounded kinds", () => {
  assertProperty(
    "matter vocabulary preserves source spelling within unique bounded kinds",
    fc.property(fc.array(source, { maxLength: 400 }), (sources) => {
      const candidates = collectVocabulary(sources);
      expect(candidates.length).toBeLessThanOrEqual(VOCABULARY_LIMITS.total);
      expect(
        new Set(
          candidates.map(({ term, kind }) => JSON.stringify([kind, term])),
        ).size,
      ).toBe(candidates.length);
      for (const kind of kinds) {
        expect(
          candidates.filter((candidate) => candidate.kind === kind).length,
        ).toBeLessThanOrEqual(VOCABULARY_LIMITS.perKind);
      }
      for (const candidate of candidates) {
        expect(candidate.term.length).toBeGreaterThan(0);
        expect(candidate.term.length).toBeLessThanOrEqual(
          VOCABULARY_LIMITS.termLength,
        );
        expect(candidate.weight).toBe(VOCABULARY_WEIGHTS[candidate.kind]);
        expect(
          sources.some(
            ({ term, kind }) =>
              kind === candidate.kind && term.trim() === candidate.term,
          ),
        ).toBe(true);
      }
      expect(collectVocabulary(candidates)).toEqual(candidates);
    }),
  );
});

test("deduplicates by kind and exact spelling while retaining the latest use", () => {
  const old = new Date("2026-01-01Z");
  const recent = new Date("2026-02-01Z");
  expect(
    collectVocabulary([
      { term: " Žofia Šťastná ", kind: "person", lastUsedAt: old },
      { term: "Žofia Šťastná", kind: "person", lastUsedAt: recent },
      { term: "Žofia Šťastná", kind: "party" },
      { term: "Zofia Stastna", kind: "person" },
      { term: "x".repeat(VOCABULARY_LIMITS.termLength + 1), kind: "glossary" },
      { term: "  ", kind: "glossary" },
    ]),
  ).toEqual([
    { term: "Žofia Šťastná", kind: "party", weight: 1 },
    { term: "Žofia Šťastná", kind: "person", lastUsedAt: recent, weight: 0.9 },
    { term: "Zofia Stastna", kind: "person", weight: 0.9 },
  ]);
});

test("enforces per-kind and total caps even with every kind populated", () => {
  const candidates = collectVocabulary(
    kinds.flatMap((kind) =>
      Array.from({ length: VOCABULARY_LIMITS.total }, (_, index) => ({
        kind,
        term: `${kind} ${index}`,
      })),
    ),
  );
  expect(candidates).toHaveLength(VOCABULARY_LIMITS.total);
  expect(candidates.filter(({ kind }) => kind === "matter-name")).toHaveLength(
    VOCABULARY_LIMITS.perKind,
  );
  expect(collectVocabulary([])).toEqual([]);
});
