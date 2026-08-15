import { expect, test } from "bun:test";

import {
  foldExpansionKey,
  isMorphologyDictionaryContentHash,
  MAX_FORMS_PER_BUCKET,
  morphologyDictionaryKey,
  morphologyDictionaryPointerKey,
  parseExpansionDictionary,
  serializeExpansionDictionary,
} from "@/api/lib/legal-search/morphology/dictionary";

test("serialize and parse are the same contract", () => {
  const { entries, skippedLines } = parseExpansionDictionary(
    serializeExpansionDictionary([
      {
        documentFrequency: 12,
        forms: ["nájemné", "nájemného"],
        stem: "nájemn",
      },
    ]),
  );
  expect(skippedLines).toBe(0);
  expect(entries.get("najemne")).toBe("nájemné,nájemného");
  // Every member of a bucket keys the same packed value, which is what makes
  // the lookup work from whichever inflection the reader typed.
  expect(entries.get("najemneho")).toBe("nájemné,nájemného");
});

// A dictionary is built offline from corpus text. One bad line must cost one
// bucket, never every query the language serves, so the parser skips and
// counts rather than throwing.
test.each([
  ["missing a field", "nájemn\tnájemné"],
  ["an extra field", "nájemn\tnájemné,nájemného\t12\textra"],
  ["a singleton bucket", "nájemn\tnájemné\t12"],
  [
    "more forms than the cap",
    `s\t${["aa", "ab", "ac", "ad", "ae"].join(",")}\t9`,
  ],
  ["a form carrying a digit", "s\tform1,form2\t9"],
  ["a form carrying a quote", 's\tfo"rm,form\t9'],
  ["a form carrying a backslash", "s\tfo\\rm,form\t9"],
  ["a form carrying a space", "s\tfo rm,form\t9"],
])("a line with %s is skipped, not thrown on", (_label, line) => {
  const parsed = parseExpansionDictionary(line);
  expect(parsed.skippedLines).toBe(1);
  expect(parsed.entries.size).toBe(0);
});

test("a bad line costs only itself", () => {
  const parsed = parseExpansionDictionary(
    ["broken", "nájemn\tnájemné,nájemného\t12", ""].join("\n"),
  );
  expect(parsed.skippedLines).toBe(1);
  expect(parsed.entries.size).toBe(2);
});

test("the cap is what the parser enforces", () => {
  const forms = Array.from({ length: MAX_FORMS_PER_BUCKET }, (_, index) =>
    "a".repeat(index + 2),
  );
  expect(
    parseExpansionDictionary(`s\t${forms.join(",")}\t9`).entries.size,
  ).toBe(MAX_FORMS_PER_BUCKET);
});

test("the fold is lowercase, NFC, and diacritic-free", () => {
  expect(foldExpansionKey("ŠKODY")).toBe("skody");
  // NFD input (common from PDFs and macOS filesystems) folds identically.
  expect(foldExpansionKey("s̋kody".normalize("NFD"))).toBe(
    foldExpansionKey("s̋kody"),
  );
});

// The pointer object's contents choose which key is read, so its shape is
// enforced rather than trusted: an unconstrained value would let a written
// pointer address any object in the bucket.
test.each([
  "../../secrets",
  "",
  "0".repeat(63),
  "0".repeat(65),
  `${"0".repeat(63)}Z`,
])("a content hash of %p is rejected", (value) => {
  expect(isMorphologyDictionaryContentHash(value)).toBe(false);
});

test("a sha256 hex hash is accepted and addresses one key", () => {
  const hash = "a".repeat(64);
  expect(isMorphologyDictionaryContentHash(hash)).toBe(true);
  expect(morphologyDictionaryKey("cs", hash)).toBe(
    `legal-corpus/morphology/language=cs/${hash}/expansion.tsv.zst`,
  );
  expect(morphologyDictionaryPointerKey("pl")).toBe(
    "legal-corpus/morphology/language=pl/current.txt",
  );
});
