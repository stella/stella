import { expect, test } from "bun:test";

import { extractCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";
import {
  CORPUS_QUERY_LEAF_BUDGET,
  corpusFreeTextClause,
  tokenizeCorpusFreeText,
} from "@/api/lib/legal-search/corpus-query";
import {
  expandTermWith,
  expansionLanguageForJurisdiction,
  shadowExpansionAttributes,
} from "@/api/lib/legal-search/expansion";
import {
  type ExpansionBucket,
  parseExpansionDictionary,
  serializeExpansionDictionary,
} from "@/api/lib/legal-search/morphology/dictionary";
import { sanitizeLogAttributes } from "@/api/lib/observability/logger";

const dictionaryOf = (buckets: readonly ExpansionBucket[]) =>
  parseExpansionDictionary(serializeExpansionDictionary(buckets)).entries;

/**
 * Buckets the Czech light stemmer really produces. `vec` is the collision the
 * prefix guard exists for: `věci`, `vek` and `veku` reduce to one stem without
 * being one word, and folding `věci` to `veci` puts it in reach of `vek`.
 */
const CS_BUCKETS = [
  {
    documentFrequency: 4200,
    forms: ["nájemné", "nájemného", "nájemném", "nájemnému"],
    stem: "nájemn",
  },
  { documentFrequency: 900, forms: ["veci", "vek", "veku"], stem: "vec" },
  { documentFrequency: 700, forms: ["ruka", "ruce", "rukou"], stem: "ruk" },
  { documentFrequency: 300, forms: ["zlo", "zla"], stem: "zl" },
] as const satisfies readonly ExpansionBucket[];

test("a term expands to its bucket's other surface forms", () => {
  const entries = dictionaryOf(CS_BUCKETS);
  expect(expandTermWith(entries, "nájemné")).toEqual([
    "nájemného",
    "nájemném",
    "nájemnému",
  ]);
});

test("an unaccented spelling reaches the accented bucket", () => {
  const entries = dictionaryOf(CS_BUCKETS);
  expect(expandTermWith(entries, "najemne")).toEqual([
    "nájemného",
    "nájemném",
    "nájemnému",
  ]);
});

// `ł` has no canonical decomposition, so a mark-stripping fold left the key
// spelled `wyłaczenie`: unreachable from an ASCII keyboard, and spelled unlike
// any lexeme the index stored. The key has to fold the way the index folded.
test("a Polish term typed without ł reaches its bucket", () => {
  const entries = dictionaryOf([
    {
      documentFrequency: 600,
      forms: ["wyłączenie", "wyłączenia"],
      stem: "wyłącz",
    },
  ]);
  expect(entries.get("wylaczenie")).toBe("wyłączenie,wyłączenia");
  expect(expandTermWith(entries, "wylaczenie")).toEqual(["wyłączenia"]);
  expect(expandTermWith(entries, "wyłączenie")).toEqual(["wyłączenia"]);
});

// Pinned from corpus data: `veci` and `vek`/`veku` share a stem but not a
// word. Three shared leading characters is what separates them.
test("a term never expands to a bucket member it shares under three characters with", () => {
  const entries = dictionaryOf(CS_BUCKETS);
  expect(expandTermWith(entries, "veci")).toEqual([]);
  expect(expandTermWith(entries, "vek")).toEqual(["veku"]);
});

// The `ruk` family is the documented borderline: `ruka`/`rukou` share the
// stem's three characters and expand into each other, `ruce` does not and is
// dropped, even though the stemmer says all three are one word.
test("the ruk family keeps only the members sharing the stem's prefix", () => {
  const entries = dictionaryOf(CS_BUCKETS);
  expect(expandTermWith(entries, "ruka")).toEqual(["rukou"]);
  expect(expandTermWith(entries, "ruce")).toEqual([]);
});

// The floor is a constant 3, not min(3, term.length): the shorter-of rule let
// two-character terms match a whole family of unrelated words.
test("a term under three characters expands to nothing", () => {
  // The bucket is real and the short term prefixes it, so the empty result is
  // the floor firing rather than a missing entry.
  const entries = dictionaryOf([
    { documentFrequency: 300, forms: ["zla", "zlo"], stem: "zl" },
  ]);
  expect(entries.get("zla")).toBe("zla,zlo");
  expect(expandTermWith(entries, "zl")).toEqual([]);
});

test("terms carrying anything but letters expand to nothing", () => {
  const entries = dictionaryOf([
    ...CS_BUCKETS,
    { documentFrequency: 800, forms: ["2020", "2021"], stem: "2020" },
  ]);
  for (const term of ["2020", "21cdo1234", "§", "c-679"]) {
    expect(expandTermWith(entries, term)).toEqual([]);
  }
});

test("a term with no bucket expands to nothing", () => {
  expect(expandTermWith(dictionaryOf(CS_BUCKETS), "smlouva")).toEqual([]);
});

// A macOS keyboard and an extracted PDF both produce decomposed text. The
// shape guard runs on the folded spelling for exactly this reason: combining
// marks are \p{M}, so testing before the fold would reject the word.
test("a decomposed query term reaches the same bucket as its precomposed spelling", () => {
  const entries = dictionaryOf(CS_BUCKETS);
  expect(expandTermWith(entries, "nájemné".normalize("NFD"))).toEqual(
    expandTermWith(entries, "nájemné"),
  );
  expect(expandTermWith(entries, "nájemné".normalize("NFD"))).not.toEqual([]);
});

test("the typed term is never repeated inside its own group", () => {
  const clause = corpusFreeTextClause("nájemné", {
    expand: (term) => expandTermWith(dictionaryOf(CS_BUCKETS), term),
  });
  expect(clause).toBe(
    '(("nájemné" OR "nájemného" OR "nájemném" OR "nájemnému"))',
  );
});

test("phrases are never expanded", () => {
  const clause = corpusFreeTextClause('"nájemné smlouvy" nájemné', {
    expand: (term) => expandTermWith(dictionaryOf(CS_BUCKETS), term),
  });
  expect(clause).toBe(
    '("nájemné smlouvy" AND ("nájemné" OR "nájemného" OR "nájemném" OR "nájemnému"))',
  );
});

test("expansion stops at the leaf budget, leftmost terms first", () => {
  const entries = dictionaryOf([
    {
      documentFrequency: 100,
      forms: ["aaa", "aaab", "aaac", "aaad"],
      stem: "aaa",
    },
  ]);
  const clause = corpusFreeTextClause("aaa aaa aaa aaa aaa aaa aaa aaa", {
    expand: (term) => expandTermWith(entries, term),
  });
  expect(clause).not.toBeNull();
  // Eight tokens, each expandable by three: the budget admits five groups
  // (8 + 5*3 = 23) and the sixth would cross it.
  const leaves = [...(clause ?? "").matchAll(/"/gu)].length / 2;
  expect(leaves).toBeLessThanOrEqual(CORPUS_QUERY_LEAF_BUDGET);
  expect(clause?.split(" OR ").length).toBe(1 + 5 * 3);
});

// `off` mode must leave the query builder exactly where it was. The pinned
// literals in corpus-query.test.ts hold the absolute shape; this holds the
// relative one: an expander with nothing to add cannot change a single byte,
// which is what a term the guards reject produces.
test.each([
  "náhrada škody",
  '"dobrá víra" a "náhrada škody"',
  "§ 2235 odst. 1",
  'smlouva) OR (court:"X" AND text:*',
  "  spaced   out  ",
])("an expander with nothing to add leaves %p byte-identical", (text) => {
  expect(corpusFreeTextClause(text, { expand: () => [] })).toBe(
    corpusFreeTextClause(text),
  );
});

// Citation identifiers reach the builder as whatever the tokenizer makes of
// them, so the guard is bound to the extractor's real patterns rather than to
// a second copy of them here: every digit-bearing token a real citation
// decomposes into must expand to nothing.
test("no digit-bearing token of a real citation expands", () => {
  const entries = dictionaryOf(CS_BUCKETS);
  const citations = extractCitations([
    {
      index: 0,
      text: [
        "ECLI:CZ:NS:2020:21.CDO.1234.2020.1",
        "sp. zn. 21 Cdo 1234/2020",
        "č. j. 27 Co 116, 119/2007-94",
        "sygn. akt II CSK 123/20",
        "C‑156/21, EU:C:2022:97",
      ].join(" a dále "),
    },
  ]);
  expect(citations.length).toBeGreaterThan(0);

  const digitBearing = citations
    .flatMap((citation) => tokenizeCorpusFreeText(citation.citationText))
    .filter((token) => /\d/u.test(token.value));
  expect(digitBearing.length).toBeGreaterThan(0);
  for (const token of digitBearing) {
    expect(expandTermWith(entries, token.value)).toEqual([]);
  }
});

test("jurisdiction routing expands only the languages phase one publishes", () => {
  expect(expansionLanguageForJurisdiction("CZE")).toBe("cs");
  expect(expansionLanguageForJurisdiction("POL")).toBe("pl");
  expect(expansionLanguageForJurisdiction("SVK")).toBeNull();
  expect(expansionLanguageForJurisdiction("EU")).toBeNull();
  expect(expansionLanguageForJurisdiction("XXX")).toBeNull();
  // An unscoped search spans every index; no one language describes it.
  expect(expansionLanguageForJurisdiction(undefined)).toBeNull();
});

// The log sanitizer drops payload-shaped attribute keys without failing, so a
// shadow event whose keys it rejects looks emitted and measures nothing.
test("every shadow-event attribute survives the log sanitizer", () => {
  const attributes = shadowExpansionAttributes({
    baseLeaves: 1,
    countryScoped: true,
    dictionaryHash: "a1b2c3d4e5f6",
    expandedLeaves: 2,
    language: "cs",
    reach: "expanded",
  } as const);
  expect(sanitizeLogAttributes(attributes)).toEqual(attributes);
});

// Every disposition must survive the sanitizer, not just the happy one: a
// reach value the sanitizer dropped would erase exactly the traffic the
// rollout is trying to measure.
test.each([
  "dictionary_inert",
  "dictionary_warming",
  "expanded",
  "no_dictionary",
  "unsupported_jurisdiction",
] as const)("the %p disposition survives the log sanitizer", (reach) => {
  const attributes = shadowExpansionAttributes({
    baseLeaves: 2,
    countryScoped: reach !== "unsupported_jurisdiction",
    dictionaryHash: reach === "expanded" ? "a1b2c3d4e5f6" : "none",
    expandedLeaves: reach === "expanded" ? 5 : 2,
    language: reach === "unsupported_jurisdiction" ? null : "cs",
    reach,
  });
  expect(sanitizeLogAttributes(attributes)).toEqual(attributes);
  expect(attributes["reach"]).toBe(reach);
  // `addedLeaves` is derived, never passed in, so it cannot disagree.
  expect(attributes["addedLeaves"]).toBe(reach === "expanded" ? 3 : 0);
});

// The event measures the rewrite; it must not carry what the reader typed. A
// case-law query can name a client or a party, and nothing else in the request
// path copies query text into telemetry.
test("the shadow event carries no query text", () => {
  const attributes = shadowExpansionAttributes({
    baseLeaves: 3,
    countryScoped: true,
    dictionaryHash: "a1b2c3d4e5f6",
    expandedLeaves: 9,
    language: "cs",
    reach: "expanded",
  } as const);
  for (const value of Object.values(attributes)) {
    expect(typeof value === "string" ? value : "").not.toContain('"');
  }
  expect(Object.values(attributes)).toEqual(
    expect.arrayContaining([3, 9, 6, true, "cs", "expanded"]),
  );
});
