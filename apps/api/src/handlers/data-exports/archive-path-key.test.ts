import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { normalizeUnicode } from "@stll/text-normalize";

import { archivePathKey } from "@/api/handlers/data-exports/archive-path-key";

const caseVariants = [
  ["a", "A"],
  ["e", "E"],
  ["é", "É", "e\u0301", "E\u0301"],
  ["č", "Č", "c\u030c", "C\u030c"],
  ["ž", "Ž", "z\u030c", "Z\u030c"],
  ["σ", "ς", "Σ"],
  ["α", "Α"],
  ["ß", "ẞ", "ss", "SS", "Ss", "sS"],
  ["ä", "Ä", "a\u0308", "A\u0308"],
] as const;

const collation = new Intl.Collator("cs", {
  usage: "search",
  sensitivity: "accent",
});

// The independent reference closes in the opposite casing direction.
const uppercaseClosure = (name: string): string => {
  let previous = name;
  for (;;) {
    const upper = normalizeUnicode(previous, "NFC").toLowerCase().toUpperCase();
    if (upper === previous) {
      return normalizeUnicode(upper, "NFC");
    }
    previous = upper;
  }
};

const piecePair = fc
  .constantFrom(...caseVariants)
  .chain((variants) =>
    fc.tuple(fc.constantFrom(...variants), fc.constantFrom(...variants)),
  );
const equivalentNames = fc
  .array(piecePair, { minLength: 1, maxLength: 12 })
  .map(
    (pieces) =>
      [
        `${pieces.map(([first]) => first).join("")}.pdf`,
        `${pieces.map(([, second]) => second).join("")}.pdf`,
      ] as const,
  );
const randomName = fc
  .array(fc.constantFrom(...caseVariants.flat()), { maxLength: 12 })
  .map((pieces) => `${pieces.join("")}.pdf`);

test("capital sharp S reaches the same stable key as its case variants", () => {
  expect(archivePathKey("ß.pdf")).toBe("ss.pdf");
  expect(archivePathKey("ẞ.pdf")).toBe("ss.pdf");
  expect(archivePathKey("SS.pdf")).toBe("ss.pdf");
});

test("archive keys close over collation and iterated case equivalence", () => {
  assertProperty(
    "archive keys close over collation and iterated case equivalence",
    fc.property(
      fc.oneof(equivalentNames, fc.tuple(randomName, randomName)),
      ([first, second]) => {
        const firstKey = archivePathKey(first);
        const secondKey = archivePathKey(second);
        if (
          collation.compare(first, second) === 0 ||
          uppercaseClosure(first) === uppercaseClosure(second)
        ) {
          expect(firstKey).toBe(secondKey);
        }
        expect(archivePathKey(firstKey)).toBe(firstKey);
        expect(archivePathKey(secondKey)).toBe(secondKey);
        expect(firstKey).toBe(normalizeUnicode(firstKey, "NFC"));
        expect(secondKey).toBe(normalizeUnicode(secondKey, "NFC"));
      },
    ),
  );
});
