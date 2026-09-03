import { expect, test } from "bun:test";

import { FOLDED_TOKENIZER } from "@/api/lib/legal-search/corpus-index-config";
import {
  type ExpansionDictionaryIdentity,
  foldExpansionKey,
  isMorphologyDictionaryContentHash,
  isSurfaceForm,
  MAX_FORMS_PER_BUCKET,
  NO_EXPANSION_DICTIONARY_IDENTITY,
  SURFACE_FORM_MAX_LENGTH,
  SURFACE_FORM_MIN_LENGTH,
  morphologyDictionaryKey,
  morphologyDictionaryPointerKey,
  parseExpansionDictionary,
  parseExpansionDictionaryIdentity,
  parseExpansionDictionaryOffLoop,
  sameExpansionDictionary,
  serializeExpansionDictionary,
  serializeExpansionDictionaryIdentity,
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
    `s\t${["aaa", "aab", "aac", "aad", "aae"].join(",")}\t9`,
  ],
  ["a form under the length floor", "s\tab,abc\t9"],
  [
    "a form past the length ceiling",
    `s\t${"a".repeat(SURFACE_FORM_MAX_LENGTH + 1)},abc\t9`,
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

// Two drivers over one line parser. If they ever disagree, a replica would be
// serving a different dictionary than the builder validated, so the agreement
// is asserted over input that exercises every branch: good lines, a malformed
// one, a collision, and enough lines to cross a yield boundary.
test("the yielding parse agrees with the synchronous one", async () => {
  const lines = [
    "rad\trada,rady,radu\t900",
    "řad\třada,řady,řadě\t800",
    "junk",
  ];
  for (let index = 0; index < 2500; index += 1) {
    lines.push(
      `s${index}\tform${"a".repeat(index % 5)}x,formbx\t${index + 60}`,
    );
  }
  const text = lines.join("\n");

  const sync = parseExpansionDictionary(text);
  const offLoop = await parseExpansionDictionaryOffLoop(text);

  expect(offLoop.skippedLines).toBe(sync.skippedLines);
  expect(offLoop.collidedKeys).toBe(sync.collidedKeys);
  const byKey = (left: [string, string], right: [string, string]): number =>
    left[0] < right[0] ? -1 : 1;
  expect([...offLoop.entries].sort(byKey)).toEqual(
    [...sync.entries].sort(byKey),
  );
  // Non-vacuity: the fixture must actually reach the interesting branches.
  expect(sync.skippedLines).toBeGreaterThan(0);
  expect(sync.collidedKeys).toBeGreaterThan(0);
  expect(sync.entries.size).toBeGreaterThan(0);
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
    "a".repeat(index + SURFACE_FORM_MIN_LENGTH),
  );
  expect(
    parseExpansionDictionary(`s\t${forms.join(",")}\t9`).entries.size,
  ).toBe(MAX_FORMS_PER_BUCKET);
});

test("the fold is lowercase, form-independent, and ASCII", () => {
  expect(foldExpansionKey("ŠKODY")).toBe("skody");
  expect(foldExpansionKey("Straße")).toBe("strasse");
  // The same word decomposed (routine from extracted PDFs and macOS
  // filesystems) must reach the same key, or half the corpus is unreachable
  // from half the keyboards.
  expect(foldExpansionKey("ŠKODY".normalize("NFD"))).toBe("skody");
  expect(foldExpansionKey("žalobě".normalize("NFD"))).toBe(
    foldExpansionKey("žalobě"),
  );
  // `ł` has no canonical decomposition, so a mark strip leaves it standing
  // while the engine's ascii folding and `unaccent()` both store `l`. A key
  // spelled with `ł` is a key no indexed lexeme can be spelled as.
  expect(foldExpansionKey("Łaska")).toBe("laska");
  expect(foldExpansionKey("zażółć")).toBe("zazolc");
});

// The key's two steps mirror the tokenizer's filter list, and the mirror is
// asserted rather than trusted: the orders are not interchangeable for a
// character whose lowercase form the fold table does not reach. `Ɩ` folds to
// `I` but lowercases to `ɩ`, so folding first would key an uppercase query on
// `iota` while the corpus form (already lowercased by `to_tsvector('simple')`,
// which is what the builder reads) keys `ɩota`.
test("the fold lowercases before it folds, the order the index applies", () => {
  // Unannotated on purpose: the tuple keeps its literal element type, so
  // dropping either filter from the tokenizer makes the argument below a
  // compile error rather than an `indexOf` returning -1 that this comparison
  // would read as an ordering. Only the ordering is left to assert at runtime.
  const { filters } = FOLDED_TOKENIZER;
  expect(filters.indexOf("lower_caser")).toBeLessThan(
    filters.indexOf("ascii_folding"),
  );
  expect(foldExpansionKey("Ɩota")).toBe(foldExpansionKey("ɩota"));
});

// A combining mark is \p{M}, not \p{L}, so a letters-only test that ran before
// canonicalisation would reject decomposed spellings of words it accepts
// precomposed.
test("a decomposed word is still a surface form", () => {
  expect(isSurfaceForm("žalobě".normalize("NFD"))).toBe(true);
  expect(isSurfaceForm("žalobě")).toBe(true);
  expect(isSurfaceForm("21cdo")).toBe(false);
});

// The leaf budget caps how many quoted values a query carries, never how long
// one is, so an unbounded form would let a payload pair an ordinary key with a
// multi-megabyte value and have an ordinary search build an enormous clause.
test("a surface form is bounded at both ends", () => {
  expect(isSurfaceForm("a".repeat(SURFACE_FORM_MIN_LENGTH - 1))).toBe(false);
  expect(isSurfaceForm("a".repeat(SURFACE_FORM_MIN_LENGTH))).toBe(true);
  expect(isSurfaceForm("a".repeat(SURFACE_FORM_MAX_LENGTH))).toBe(true);
  expect(isSurfaceForm("a".repeat(SURFACE_FORM_MAX_LENGTH + 1))).toBe(false);
});

// Keys are folded and values are not, so two stems that differ only by
// diacritics claim one key. Czech rada/řada and Polish sad/sąd are ordinary
// words: answering a query for one with the other's inflections is a wrong
// answer the prefix guard cannot catch, because the folded spellings agree.
test("a folded key two stems claim expands to nothing", () => {
  const parsed = parseExpansionDictionary(
    ["rad\trada,rady,radu\t900", "řad\třada,řady,řadě\t800"].join("\n"),
  );
  expect(parsed.collidedKeys).toBeGreaterThan(0);
  expect(parsed.entries.get("rada")).toBeUndefined();
  expect(parsed.entries.get("rady")).toBeUndefined();
  // Keys only one stem claims are unaffected.
  expect(parsed.entries.get("radu")).toBe("rada,rady,radu");
  expect(parsed.entries.get("rade")).toBe("řada,řady,řadě");
});

// Folding to ASCII widens the ambiguous set rather than narrowing it: `łaska`
// and `laska` are distinct Polish words that the index stores under one
// lexeme, so they are the same ambiguity as rada/řada and get the same answer.
// Under a mark strip they kept separate keys and each expanded to the other
// family's inflections, which the index could never have matched anyway.
test("a Polish ł/l pair claims one key and expands to nothing", () => {
  const parsed = parseExpansionDictionary(
    ["łask\tłaska,łaski\t400", "lask\tlaska,laski\t300"].join("\n"),
  );
  expect(parsed.collidedKeys).toBe(2);
  expect(parsed.entries.get("laska")).toBeUndefined();
  expect(parsed.entries.get("laski")).toBeUndefined();
  expect(parsed.entries.size).toBe(0);
});

// Order must not decide the answer: the same two buckets serialized either way
// round drop the same keys.
test("collision handling does not depend on serialization order", () => {
  const first = "rad\trada,rady,radu\t900";
  const second = "řad\třada,řady,řadě\t800";
  const forward = parseExpansionDictionary([first, second].join("\n"));
  const reverse = parseExpansionDictionary([second, first].join("\n"));
  expect([...forward.entries.keys()].sort()).toEqual(
    [...reverse.entries.keys()].sort(),
  );
  expect(forward.collidedKeys).toBe(reverse.collidedKeys);
});

// Two forms of one family may fold together; that is the same answer twice.
test("forms folding together inside one bucket are not a collision", () => {
  const parsed = parseExpansionDictionary("rad\trada,ráda,radu\t900");
  expect(parsed.collidedKeys).toBe(0);
  expect(parsed.entries.get("rada")).toBe("rada,ráda,radu");
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

test("an identity round-trips through its serialized form", () => {
  const hash = "b".repeat(64);
  for (const identity of [
    { contentHash: hash, type: "dictionary" },
    NO_EXPANSION_DICTIONARY_IDENTITY,
  ] as const satisfies readonly ExpansionDictionaryIdentity[]) {
    expect(
      parseExpansionDictionaryIdentity(
        serializeExpansionDictionaryIdentity(identity),
      ),
    ).toEqual(identity);
  }
});

// The sentinel and a payload's hash share one field, so they must be
// distinguishable in it: a hash is 64 hex characters and the sentinel is not.
test("no dictionary is never the same identity as a dictionary", () => {
  expect(
    sameExpansionDictionary(NO_EXPANSION_DICTIONARY_IDENTITY, {
      contentHash: "c".repeat(64),
      type: "dictionary",
    }),
  ).toBe(false);
  expect(
    isMorphologyDictionaryContentHash(
      serializeExpansionDictionaryIdentity(NO_EXPANSION_DICTIONARY_IDENTITY),
    ),
  ).toBe(false);
});

test.each(["", "none ", "NONE", "d".repeat(63), `${"d".repeat(63)}Z`])(
  "an identity field of %p is not one this service issued",
  (value) => {
    expect(parseExpansionDictionaryIdentity(value)).toBeNull();
  },
);
