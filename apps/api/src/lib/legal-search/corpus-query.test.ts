import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { PROVISION_CITATION_PROFILES } from "@stll/legal-atlas/provision-citation-profiles";
import { propertyConfig } from "@stll/property-testing";

import { caseLawCorpusQueryFields } from "@/api/lib/legal-search/corpus-index-read-contract";
import {
  CORPUS_QUERY_LEAF_BUDGET,
  caseLawCorpusQuery,
  type CorpusStemming,
  type CorpusFreeTextOptions,
  corpusDecisionTypeClause,
  corpusFreeTextClause,
  type CorpusTermExpander,
  partitionCorpusQueryTokens,
  quoteCorpusValue,
  tokenizeCorpusFreeText,
} from "@/api/lib/legal-search/corpus-query";
import {
  CORPUS_INDEX_QUERY_VARIANTS,
  CORPUS_QUERY_VARIANT_POLICY,
  type CorpusIndexQueryVariant,
} from "@/api/lib/legal-search/corpus-query-variant-policy";
import { functionWordsFor } from "@/api/lib/legal-search/morphology/function-words";
import {
  LEGACY_STEMMERS,
  MORPHOLOGY_LANGUAGES,
} from "@/api/lib/legal-search/morphology/stem";

test("free text cannot escape into the query DSL", () => {
  expect(corpusFreeTextClause('smlouva) OR (court:"X" AND text:*')).toBe(
    '("smlouva" AND "OR" AND "court" AND "X" AND "AND" AND "text")',
  );
});

test("unicode terms survive intact", () => {
  expect(corpusFreeTextClause("nájemné smlouvy § 2235")).toBe(
    '("nájemné" AND "smlouvy" AND "2235")',
  );
});

test("input without searchable terms yields no clause", () => {
  expect(corpusFreeTextClause("?!()*:\\")).toBeNull();
});

test("filter values escape backslashes before quotes", () => {
  expect(quoteCorpusValue("foo\\")).toBe('"foo\\\\"');
  expect(quoteCorpusValue('a"b')).toBe('"a\\"b"');
});

// Pins the pre-phrase clause shape for quote-free input: the phrase parser
// must be invisible to every query that does not use quotes.
test.each([
  ["náhrada škody", '("náhrada" AND "škody")'],
  ["  spaced   out  ", '("spaced" AND "out")'],
  ["§ 2235 odst. 1", '("2235" AND "odst" AND "1")'],
  ["one", '("one")'],
])("quote-free input %p keeps its existing clause", (input, expected) => {
  expect(corpusFreeTextClause(input)).toBe(expected);
});

test("a straight-quoted span becomes one phrase clause", () => {
  expect(corpusFreeTextClause('"náhrada škody"')).toBe('("náhrada škody")');
});

test("phrases and loose terms keep their written order", () => {
  expect(corpusFreeTextClause('bezdůvodné "náhrada škody" obohacení')).toBe(
    '("bezdůvodné" AND "náhrada škody" AND "obohacení")',
  );
});

test("several phrases each become their own clause", () => {
  expect(corpusFreeTextClause('"dobrá víra" a "náhrada škody"')).toBe(
    '("dobrá víra" AND "a" AND "náhrada škody")',
  );
});

// The corpus is written in several typographic conventions; a phrase pasted
// out of a judgment must be read as a phrase whichever pair it carries.
test.each([
  ["„náhrada škody“", "czech"],
  ["„náhrada škody”", "polish"],
  ["“náhrada škody”", "english"],
  ["«náhrada škody»", "french"],
  ["»náhrada škody«", "german-guillemet"],
])("%p (%s quotes) is a phrase", (input) => {
  expect(corpusFreeTextClause(input)).toBe('("náhrada škody")');
});

test("mixed quote conventions coexist in one query", () => {
  expect(corpusFreeTextClause('„dobrá víra“ a "náhrada škody"')).toBe(
    '("dobrá víra" AND "a" AND "náhrada škody")',
  );
});

// Never an engine parse error: an unclosed quote degrades to the terms it
// would have produced without it.
test.each([
  ['smlouva "náhrada škody', '("smlouva" AND "náhrada" AND "škody")'],
  ['"', null],
  ["„nájemné", '("nájemné")'],
  ['a "b" "c', '("a" AND "b" AND "c")'],
])("unbalanced quote in %p degrades to terms", (input, expected) => {
  expect(corpusFreeTextClause(input)).toBe(expected);
});

test.each([
  ['""', null],
  ['"   "', null],
  ["„ “", null],
  ['smlouva ""', '("smlouva")'],
  ['"" smlouva', '("smlouva")'],
])("empty phrase %p contributes no clause", (input, expected) => {
  expect(corpusFreeTextClause(input)).toBe(expected);
});

// Phrase content is tokenized to word characters exactly as a loose term is,
// so nothing inside a phrase can reach the engine's parser. Every expectation
// below is a clause with balanced quotes and no field, boolean, wildcard, or
// escape left in it.
test.each([
  ['"a\\" OR text:*"', '("a" AND "OR" AND "text")'],
  ['"náhrada\\" AND court:\\"X"', '("náhrada" AND "AND" AND "court" AND "X")'],
  ['"foo\\\\"', '("foo")'],
  ['"a" OR "b"', '("a" AND "OR" AND "b")'],
  ['"text:* AND court:X"', '("text AND court X")'],
  ['"(a OR b)"', '("a OR b")'],
  ['"a~2 b^3"', '("a 2 b 3")'],
  ['«court:"X"»', '("court X")'],
])("injection attempt %p stays literal", (input, expected) => {
  expect(corpusFreeTextClause(input)).toBe(expected);
});

test("no clause ever carries an unescaped quote or backslash", () => {
  const attempts = [
    '"a\\" OR text:*"',
    'smlouva "náhrada\\škody"',
    '„a\\"b“',
    '"\\\\\\\\"',
    'court:"X" "y\\"',
  ];
  for (const attempt of attempts) {
    const clause = corpusFreeTextClause(attempt);
    if (clause === null) {
      continue;
    }
    expect(clause).not.toContain("\\");
    // Balanced quoting: every clause is `("t" AND "t" ...)`, so the quote
    // count is even and no bare quote can terminate a phrase early.
    expect((clause.match(/"/gu) ?? []).length % 2).toBe(0);
  }
});

test("a phrase collapses internal whitespace to single separators", () => {
  expect(corpusFreeTextClause('"náhrada    škody"')).toBe('("náhrada škody")');
  expect(corpusFreeTextClause('"náhrada\n\tškody"')).toBe('("náhrada škody")');
});

test("diacritics and non-Latin scripts survive a phrase", () => {
  expect(corpusFreeTextClause('"příslušenství pohledávky"')).toBe(
    '("příslušenství pohledávky")',
  );
  expect(corpusFreeTextClause('" عقد الإيجار"')).toBe('("عقد الإيجار")');
});

test("an apostrophe does not open a phrase span", () => {
  expect(corpusFreeTextClause("l'état d'urgence")).toBe(
    '("l" AND "état" AND "d" AND "urgence")',
  );
});

// The tokenizer is the single splitter over this input: a consumer that
// rewrites terms (and must leave phrases alone) reads these tokens rather than
// re-scanning the raw query, so the phrase boundary is decided in one place.
test("the tokenizer labels phrases and terms in written order", () => {
  expect(
    tokenizeCorpusFreeText('bezdůvodné "náhrada škody" a „dobrá víra“'),
  ).toEqual([
    { type: "term", value: "bezdůvodné" },
    { type: "phrase", value: "náhrada škody" },
    { type: "term", value: "a" },
    { type: "phrase", value: "dobrá víra" },
  ]);
});

test("a token's value is already reduced to word characters", () => {
  expect(tokenizeCorpusFreeText('"text:* AND court:X" § 2235')).toEqual([
    { type: "phrase", value: "text AND court X" },
    { type: "term", value: "2235" },
  ]);
});

test("a one-word quoted span is still a phrase token", () => {
  expect(tokenizeCorpusFreeText('"smlouva"')).toEqual([
    { type: "phrase", value: "smlouva" },
  ]);
});

test("unbalanced and empty spans produce no phrase token", () => {
  expect(tokenizeCorpusFreeText('smlouva "náhrada')).toEqual([
    { type: "term", value: "smlouva" },
    { type: "term", value: "náhrada" },
  ]);
  expect(tokenizeCorpusFreeText('""')).toEqual([]);
});

test("the clause is exactly the tokenization, quoted and ANDed", () => {
  for (const input of [
    'bezdůvodné "náhrada škody" obohacení',
    "nájemné smlouvy § 2235",
    '„dobrá víra“ a "náhrada škody"',
    'smlouva) OR (court:"X" AND text:*',
  ]) {
    const tokens = tokenizeCorpusFreeText(input);
    expect(corpusFreeTextClause(input)).toBe(
      `(${tokens.map((token) => quoteCorpusValue(token.value)).join(" AND ")})`,
    );
  }
});

test("the assembler ANDs filter clauses onto the free-text clause", () => {
  expect(
    caseLawCorpusQuery({
      jurisdiction: undefined,
      text: '"náhrada škody"',
      filters: {
        court: "Nejvyšší soud",
        dateFrom: "2020-01-01",
        dateTo: "2024-12-31",
        documentType: "rozsudek",
        jurisdiction: "CZE",
        language: "cs",
        source: "7449df27-2067-4827-b22f-3091f564ae50",
      },
    }),
  ).toBe(
    '("náhrada škody")' +
      ' AND jurisdiction:"CZE"' +
      ` AND ${corpusDecisionTypeClause("rozsudek")}` +
      ' AND source:"7449df27-2067-4827-b22f-3091f564ae50"' +
      ' AND language:"cs"' +
      ' AND court:"Nejvyšší soud"' +
      " AND decision_date:[2020-01-01 TO 2024-12-31]",
  );
});

test("a type filter names every stored spelling of its kind, so an abbreviation is not missed", () => {
  const order = corpusDecisionTypeClause("order");
  expect(corpusDecisionTypeClause("usnesení")).toBe(order);
  expect(corpusDecisionTypeClause("Usn.")).toBe(order);
  for (const spelling of ["usnesení", "usn.", "uznesenie", "postanowienie"]) {
    expect(order).toContain(`document_type:${quoteCorpusValue(spelling)}`);
  }
  expect(order).not.toContain(quoteCorpusValue("rozsudek"));
  expect(order).toMatch(
    /^\(document_type:"[^"]+"( OR document_type:"[^"]+")+\)$/u,
  );

  // The raw field is exact, so every stored casing and joined list is named.
  for (const stored of ["Uznesenie", "uznesenie,uznesenie"]) {
    expect(order).toContain(`document_type:${quoteCorpusValue(stored)}`);
  }

  // The catch-all is a stated type none of the kinds' spellings is: what is
  // read as `other` (a docket, `jinak`) stays out of the exclusion.
  const other = corpusDecisionTypeClause("other");
  expect(other.startsWith("(document_type:* AND NOT (")).toBe(true);
  expect(other).toContain(`document_type:${quoteCorpusValue("usn.")}`);
  expect(other).not.toContain(quoteCorpusValue("jinak"));
  expect(other).not.toContain(quoteCorpusValue("63 az 17/2026 - 28"));

  // A value no kind claims is matched as stated.
  expect(corpusDecisionTypeClause("jiné")).toBe('document_type:"jiné"');
});

test("a court filter carries its partitions beside the exact court clause, never alone", () => {
  expect(
    caseLawCorpusQuery({
      jurisdiction: undefined,
      text: "habeas",
      filters: {
        court: "Supreme Court of the United States",
        courtPartitions: ["p08"],
        dateFrom: "1800-01-01",
      },
    }),
  ).toBe(
    '("habeas")' +
      ' AND court:"Supreme Court of the United States"' +
      ' AND (court_partition:"p08")' +
      " AND decision_date:[1800-01-01 TO *]",
  );
  expect(
    caseLawCorpusQuery({
      jurisdiction: undefined,
      text: "habeas",
      filters: { court: "A", courtPartitions: ["p01", "p02"] },
    }),
  ).toBe(
    '("habeas") AND court:"A" AND (court_partition:"p01" OR court_partition:"p02")',
  );
  // Without a court filter there is nothing for a partition to narrow.
  expect(
    caseLawCorpusQuery({
      jurisdiction: undefined,
      text: "habeas",
      filters: { courtPartitions: ["p08"] },
    }),
  ).toBe('("habeas")');
});

test("an open-ended date range keeps the wildcard bound", () => {
  expect(
    caseLawCorpusQuery({
      jurisdiction: undefined,
      text: "smlouva",
      filters: { dateFrom: "2020-01-01" },
    }),
  ).toBe('("smlouva") AND decision_date:[2020-01-01 TO *]');
  expect(
    caseLawCorpusQuery({
      jurisdiction: undefined,
      text: "smlouva",
      filters: { dateTo: "2020-01-01" },
    }),
  ).toBe('("smlouva") AND decision_date:[* TO 2020-01-01]');
});

test("no filters leaves the free-text clause alone", () => {
  expect(
    caseLawCorpusQuery({
      jurisdiction: undefined,
      text: "smlouva",
      filters: {},
    }),
  ).toBe('("smlouva")');
});

test("text without a searchable term yields no query", () => {
  expect(
    caseLawCorpusQuery({
      jurisdiction: undefined,
      text: "?!()",
      filters: { court: "Nejvyšší soud" },
    }),
  ).toBeNull();
  expect(
    caseLawCorpusQuery({ jurisdiction: undefined, text: '""', filters: {} }),
  ).toBeNull();
});

// A filter value reaching the engine unescaped would let a caller that does
// not validate its inputs (the provider takes them straight from its caller)
// close the clause and append DSL of its own.
test("filter values cannot close their clause", () => {
  expect(
    caseLawCorpusQuery({
      jurisdiction: undefined,
      text: "smlouva",
      filters: { court: 'X" OR text:*' },
    }),
  ).toBe('("smlouva") AND court:"X\\" OR text:*"');
  expect(
    caseLawCorpusQuery({
      jurisdiction: undefined,
      text: "smlouva",
      filters: { language: "cs\\" },
    }),
  ).toBe('("smlouva") AND language:"cs\\\\"');
});

const CS_STEMMING = {
  language: "cs",
  fields: ["text_stem", "headnote_stem"],
} as const satisfies CorpusStemming;

test("a term carries a stem alternative beside the word as typed", () => {
  // The surface leaf is unscoped and still reaches every default field; the
  // stem leaves name their fields, because a bare term must never be matched
  // against a spelling the reader did not write.
  expect(corpusFreeTextClause("nájemního", { stemming: CS_STEMMING })).toBe(
    '(("nájemního" OR text_stem:"nájemn" OR headnote_stem:"nájemn"))',
  );
});

test("an extra surface field is named, never reached by a bare term", () => {
  expect(
    corpusFreeTextClause("nájemního", { surfaceFields: ["headnote"] }),
  ).toBe('(("nájemního" OR headnote:"nájemního"))');
  expect(
    corpusFreeTextClause('"nájemního bytu"', { surfaceFields: ["headnote"] }),
  ).toBe('(("nájemního bytu" OR headnote:"nájemního bytu"))');
});

/**
 * The research answer runner hands every hit's stored `text` to the answer
 * model as the excerpt that matched, so its retrieval must never match a field
 * written to one passage of a document: a summary-only hit would return the
 * opening passage with text that does not carry the terms. It builds its
 * clause with no extra fields, and the index's default fields no longer carry
 * the summary, so neither half can reach one.
 */
test("a clause built with no extra fields names no field at all", () => {
  const clause = corpusFreeTextClause("nájemního bytu");

  expect(clause).toBe('("nájemního" AND "bytu")');
  expect(clause).not.toContain("headnote");
  expect(clause).not.toContain("_stem");
});

test("the decisions query names the summary where its generation maps one", () => {
  const decisions = caseLawCorpusQuery({
    jurisdiction: undefined,
    text: "nájemního",
    filters: { jurisdiction: "CZE" },
    surfaceFields: ["headnote"],
    stemming: CS_STEMMING,
  });

  expect(decisions).toContain('headnote:"nájemního"');
  expect(decisions).toContain('headnote_stem:"nájemn"');
  // The same query for a generation that maps neither is what it is today.
  expect(
    caseLawCorpusQuery({
      jurisdiction: undefined,
      text: "nájemního",
      filters: { jurisdiction: "CZE" },
    }),
  ).toBe('("nájemního") AND jurisdiction:"CZE"');
});

test("a phrase carries a stemmed phrase, word for word", () => {
  // Stems joined by single spaces, so the stemmed phrase is as adjacent as
  // the surface phrase: two words in, two stems out.
  expect(
    corpusFreeTextClause('"nájemního bytu"', { stemming: CS_STEMMING }),
  ).toBe(
    '(("nájemního bytu" OR text_stem:"nájemn byt" OR headnote_stem:"nájemn byt"))',
  );
});

test("stem clauses compose with expansion rather than replacing it", () => {
  const clause = corpusFreeTextClause("nájemné", {
    expand: () => ["nájemného"],
    stemming: CS_STEMMING,
  });

  expect(clause).toBe(
    '(("nájemné" OR "nájemného" OR text_stem:"nájemn" OR headnote_stem:"nájemn"))',
  );
});

// Every leaf group the budget can grant reaches the clause, exactly once and
// in the written order: the group union is the pass list itself, so a group no
// pass spends cannot exist, and a group spent twice would repeat its leaves
// here. The stem leaves are last though the budget buys them first.
test("each leaf group is granted once, in the order a group is written", () => {
  expect(
    corpusFreeTextClause("nájemné", {
      expand: () => ["nájemného"],
      stemming: CS_STEMMING,
      surfaceFields: ["headnote"],
    }),
  ).toBe(
    '(("nájemné" OR "nájemného" OR headnote:"nájemné"' +
      ' OR text_stem:"nájemn" OR headnote_stem:"nájemn"))',
  );
});

test("a generation without extra fields gets the query it gets today", () => {
  for (const text of [
    "náhrada škody",
    '"dobrá víra" a "náhrada škody"',
    "§ 2235 odst. 1",
  ]) {
    expect(
      corpusFreeTextClause(text, { stemming: null, surfaceFields: [] }),
    ).toBe(corpusFreeTextClause(text));
    expect(
      caseLawCorpusQuery({
        jurisdiction: undefined,
        text,
        filters: { jurisdiction: "CZE" },
      }),
    ).toBe(
      caseLawCorpusQuery({
        jurisdiction: undefined,
        text,
        filters: { jurisdiction: "CZE" },
        stemming: null,
      }),
    );
  }
});

test("text that stems to nothing carries no stem leaf", () => {
  // Digits tokenize but stem to themselves, so the leaf is still worth
  // emitting; text with no token at all yields no clause in the first place.
  expect(corpusFreeTextClause("§ ()", { stemming: CS_STEMMING })).toBeNull();
});

test("the leaf budget counts stem leaves too", () => {
  const clause = corpusFreeTextClause(
    "nájemního nájemního nájemního nájemního nájemního nájemního nájemního nájemního",
    { stemming: CS_STEMMING },
  );

  expect(clause).not.toBeNull();
  const leaves = [...(clause ?? "").matchAll(/"/gu)].length / 2;
  expect(leaves).toBeLessThanOrEqual(CORPUS_QUERY_LEAF_BUDGET);
});

/** Quoted values in a clause, which is what the leaf budget counts. */
const countLeaves = (clause: string): number =>
  [...clause.matchAll(/"/gu)].length / 2;

/** The AND-ed groups of a free-text clause, outer parentheses removed. */
const clauseGroups = (clause: string): string[] =>
  clause.slice(1, -1).split(" AND ");

/** Field-scoped leaves of a clause, e.g. `text_stem:"nájemn"`. */
const fieldLeaves = (clause: string): string[] =>
  [...clause.matchAll(/[a-z_]+:"[^"]*"/gu)].map(([leaf]) => leaf);

// Every group is AND-ed, so a word the corpus carries only in another case
// form empties the whole result set on its own. Spending the budget left to
// right starved exactly the words a reader adds to narrow a search: the last
// ones.
test("a long query's later words still carry their stems", () => {
  const expansions = new Map([
    ["nájemní", ["nájemního", "nájemnímu", "nájemním"]],
    ["smlouva", ["smlouvy", "smlouvě", "smlouvou"]],
    ["výpověď", ["výpovědi", "výpovědí", "výpovědím"]],
    ["bytu", ["byt", "bytem", "byty"]],
    ["důvod", ["důvodu", "důvody", "důvodem"]],
  ]);
  const expand: CorpusTermExpander = (term) => expansions.get(term) ?? [];

  const clause = corpusFreeTextClause(
    "nájemní smlouva výpověď bytu důvod přiměřenosti",
    { expand, stemming: CS_STEMMING },
  );

  expect(clause).not.toBeNull();
  const groups = clauseGroups(clause ?? "");
  expect(groups).toHaveLength(6);
  for (const group of groups) {
    expect(group).toContain('text_stem:"');
    expect(group).toContain('headnote_stem:"');
  }
  // The last word is the one the corpus writes as `přiměřenost`; nothing but
  // its stem leaf reaches that judgment, and it has no dictionary forms here.
  expect(groups.at(-1)).toStartWith('("přiměřenosti" OR text_stem:"');
  expect(countLeaves(clause ?? "")).toBeLessThanOrEqual(
    CORPUS_QUERY_LEAF_BUDGET,
  );
});

// Legal alternatives spend what the stems leave: every word keeps its stems,
// and a word's alternatives are granted whole or not at all.
test("legal alternatives never cost a word its stems or break the budget", () => {
  const legalAlternatives: CorpusTermExpander = (term) =>
    term === "kauce" ? ["jistota", "záloha", "peněžitá jistota"] : [];
  const clause = corpusFreeTextClause(
    "vrácení kauce nájemce pronajímatel byt smlouva",
    { legalAlternatives, stemming: CS_STEMMING },
  );

  expect(clause).not.toBeNull();
  for (const group of clauseGroups(clause ?? "")) {
    expect(group).toContain('text_stem:"');
  }
  expect(countLeaves(clause ?? "")).toBeLessThanOrEqual(
    CORPUS_QUERY_LEAF_BUDGET,
  );
  const kauce = clauseGroups(clause ?? "").at(1) ?? "";
  const granted = ["jistota", "záloha", "peněžitá jistota"].filter(
    (alternative) => kauce.includes(`"${alternative}"`),
  );
  expect([0, 3]).toContain(granted.length);
});

test("a phrase never gains legal alternatives", () => {
  expect(
    corpusFreeTextClause('"vrácení kauce"', {
      legalAlternatives: () => ["jistota"],
    }),
  ).toBe('("vrácení kauce")');
});

const STEM_FIELDS = ["text_stem", "headnote_stem"] as const;

const wordArbitrary = fc
  .array(fc.constantFrom(...Array.from("aeioumnprstvzáéíýčřšž")), {
    minLength: 3,
    maxLength: 10,
  })
  .map((letters) => letters.join(""));

const queryArbitrary = fc.record({
  fields: fc.subarray([...STEM_FIELDS], { minLength: 1 }),
  words: fc.array(
    fc.record({
      extras: fc.integer({ max: 4, min: 0 }),
      word: wordArbitrary,
    }),
    { maxLength: 12, minLength: 1 },
  ),
});

/**
 * A word's stem leaves are what makes it reachable at all in an inflected
 * corpus, so the budget must buy every word's before it buys any word's
 * dictionary forms. The baseline is what the same word gets as a query of its
 * own, where the budget cannot bind: deriving it from the builder rather than
 * restemming here keeps the property from re-encoding the stemmer.
 *
 * The condition is the stem pass's own cost: one surface leaf per word, plus
 * one stem leaf per word per stem field.
 */
test("every word keeps its stem leaves while the stem pass fits", () => {
  fc.assert(
    fc.property(queryArbitrary, ({ fields, words }) => {
      const stemming: CorpusStemming = { fields, language: "cs" };
      const forms = new Map(
        words.map(({ extras, word }) => [
          word,
          Array.from(
            { length: extras },
            (_unused, index) => `${word}x${index}`,
          ),
        ]),
      );
      const expand: CorpusTermExpander = (term) => forms.get(term) ?? [];

      const clause = corpusFreeTextClause(
        words.map(({ word }) => word).join(" "),
        { expand, stemming },
      );
      expect(clause).not.toBeNull();
      const groups = clauseGroups(clause ?? "");
      expect(groups).toHaveLength(words.length);
      expect(countLeaves(clause ?? "")).toBeLessThanOrEqual(
        CORPUS_QUERY_LEAF_BUDGET,
      );

      if (words.length * (1 + fields.length) > CORPUS_QUERY_LEAF_BUDGET) {
        return;
      }
      for (const [index, { word }] of words.entries()) {
        const alone = corpusFreeTextClause(word, { stemming }) ?? "";
        const group = groups[index] ?? "";
        for (const leaf of fieldLeaves(alone)) {
          expect(group).toContain(leaf);
        }
      }
    }),
    propertyConfig(),
  );
});

test("court lists are exact OR terms intersected with a singular court", () => {
  expect(
    caseLawCorpusQuery({
      text: "smlouva",
      jurisdiction: undefined,
      filters: {
        courts: ["Nejvyšší soud", "Nejvyšší správní soud", "Ústavní soud"],
      },
    }),
  ).toBe(
    '("smlouva") AND (court:"Nejvyšší soud" OR court:"Nejvyšší správní soud" OR court:"Ústavní soud")',
  );
  expect(
    caseLawCorpusQuery({
      text: "smlouva",
      jurisdiction: undefined,
      filters: { court: "Ústavní soud", courts: ['A" OR court:*'] },
    }),
  ).toBe('("smlouva") AND court:"Ústavní soud" AND (court:"A\\" OR court:*")');
});

const SK_STEMMING = {
  language: "sk",
  fields: STEM_FIELDS,
} as const satisfies CorpusStemming;

/** Compare candidate free text with the unchanged baseline allocator. */
const svkFreeText = (text: string, options: CorpusFreeTextOptions = {}) => {
  const stemming = options.stemming ?? null;
  const legacyStemmer =
    stemming === null ? null : LEGACY_STEMMERS[stemming.language];
  const query = caseLawCorpusQuery({
    legacyStemming:
      stemming !== null && legacyStemmer !== null
        ? {
            fields: stemming.fields.filter((field) =>
              STEM_FIELDS.some((declared) => declared === field),
            ),
            stemTerm: legacyStemmer,
          }
        : null,
    jurisdiction: "SVK",
    text,
    ...options,
    filters: { jurisdiction: "SVK" },
  });
  return query === null
    ? null
    : query.slice(0, -' AND jurisdiction:"SVK"'.length);
};

test("Slovak terms OR faithful stems beside extended stems in declared fields", () => {
  expect(svkFreeText("premlčanie", { stemming: SK_STEMMING })).toBe(
    '(("premlčanie" OR text_stem:"premlčan" OR headnote_stem:"premlčan" OR text_stem:"premlčani" OR headnote_stem:"premlčani"))',
  );
  const baseline = corpusFreeTextClause("súd", { stemming: SK_STEMMING });
  expect(svkFreeText("súd", { stemming: SK_STEMMING })).toBe(baseline);
  expect(svkFreeText('"premlčanie škodu"', { stemming: SK_STEMMING })).toBe(
    corpusFreeTextClause('"premlčanie škodu"', { stemming: SK_STEMMING }),
  );
});

test("Slovak compatibility preserves NFC normalization and quoted term boundaries", () => {
  const composed = 'premlčanie "premlčanie škodu" škodu';
  const decomposed = composed.normalize("NFD");
  expect(decomposed).not.toBe(composed);
  const candidate = svkFreeText(composed, { stemming: SK_STEMMING });
  expect(svkFreeText(decomposed, { stemming: SK_STEMMING })).toBe(candidate);
  const groups = clauseGroups(candidate ?? "");
  expect(groups.at(1)).toBe(
    clauseGroups(
      corpusFreeTextClause('"premlčanie škodu"', { stemming: SK_STEMMING }) ??
        "",
    ).at(0),
  );
});

test("only manifest-declared text and headnote stem fields gain faithful alternatives", () => {
  for (const fields of [
    [],
    ["text_stem"],
    ["headnote_stem"],
    ["custom_stem"],
    ["text_stem", "custom_stem"],
  ]) {
    const stemming = {
      language: "sk",
      fields,
    } as const satisfies CorpusStemming;
    const candidate = svkFreeText("premlčanie", { stemming }) ?? "";
    const baseline = corpusFreeTextClause("premlčanie", { stemming }) ?? "";
    const extra = fieldLeaves(candidate).filter(
      (leaf) => !fieldLeaves(baseline).includes(leaf),
    );
    expect(extra).toEqual(
      fields
        .filter((field) => STEM_FIELDS.some((allowed) => allowed === field))
        .map((field) => `${field}:"premlčani"`),
    );
  }
});

test("faithful groups spend headroom whole and never displace a baseline grant", () => {
  for (const count of [7, 8, 9, 24, 25]) {
    const text = Array.from({ length: count }, () => "premlčanie").join(" ");
    const baseline =
      corpusFreeTextClause(text, { stemming: SK_STEMMING }) ?? "";
    const candidate = svkFreeText(text, { stemming: SK_STEMMING }) ?? "";
    if (count === 7) {
      expect(countLeaves(baseline)).toBe(21);
      expect(countLeaves(candidate)).toBe(23);
      expect(clauseGroups(candidate).at(1)).toBe(clauseGroups(baseline).at(1));
    } else {
      expect(candidate).toBe(baseline);
    }
    expect(clauseGroups(candidate)).toHaveLength(count);
  }
});

test("non-SVK queries stay byte-identical for every morphology language", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...MORPHOLOGY_LANGUAGES),
      fc.array(
        fc.constantFrom(
          "premlčanie",
          "nájemního",
          "škodu",
          '"náhrada škody"',
          "Mietverträge",
        ),
        { minLength: 1, maxLength: 10 },
      ),
      (language, words) => {
        const text = words.join(" ");
        const stemming = { language, fields: STEM_FIELDS };
        const baseline = corpusFreeTextClause(text, { stemming });
        if (baseline === null) {
          panic("Searchable test terms must produce a baseline clause");
        }
        for (const jurisdiction of ["CZE", "POL", "DEU", undefined]) {
          const candidate = caseLawCorpusQuery({
            jurisdiction,
            text,
            stemming,
            filters: { jurisdiction },
          });
          expect(candidate).toBe(
            jurisdiction === undefined
              ? baseline
              : `${baseline} AND jurisdiction:${quoteCorpusValue(jurisdiction)}`,
          );
        }
        if (language !== "sk") {
          expect(svkFreeText(text, { stemming })).toBe(baseline);
        }
      },
    ),
    propertyConfig(),
  );
});

test("Slovak compatibility preserves all baseline leaves and the actual leaf ceiling", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.constantFrom(
          "premlčanie",
          "škodu",
          "súd",
          '"premlčanie škodu"',
          "premlčanie) OR (text:*",
        ),
        { minLength: 0, maxLength: 12 },
      ),
      fc.subarray([...STEM_FIELDS], { minLength: 0 }),
      fc.integer({ min: 0, max: 5 }),
      (words, fields, expansionCount) => {
        const text = words.join(" ");
        const options = {
          stemming: {
            language: "sk",
            fields,
          } as const satisfies CorpusStemming,
          expand: () =>
            Array.from(
              { length: expansionCount },
              (_unused, index) => `forma${index}`,
            ),
          surfaceFields: ["headnote"],
          keywordFields: ["keywords"],
          legalAlternatives: () => ["súd"],
        };
        const baseline = corpusFreeTextClause(text, options);
        const candidate = svkFreeText(text, options);
        if (baseline === null) {
          expect(candidate).toBeNull();
          return;
        }
        const baselineGroups = clauseGroups(baseline);
        const candidateGroups = clauseGroups(candidate ?? "");
        expect(candidateGroups).toHaveLength(baselineGroups.length);
        for (const [index, group] of baselineGroups.entries()) {
          const candidateGroup = candidateGroups.at(index) ?? "";
          if (candidateGroup === group) {
            continue;
          }
          expect(candidateGroup).toStartWith(`${group.slice(0, -1)} OR `);
          const extra = fieldLeaves(candidateGroup).filter(
            (leaf) => !fieldLeaves(group).includes(leaf),
          );
          expect(extra).toHaveLength(fields.length);
          expect(
            extra.every((leaf) =>
              fields.some((field) => leaf.startsWith(`${field}:`)),
            ),
          ).toBe(true);
          expect(candidateGroup).not.toContain("*");
        }
        expect(countLeaves(candidate ?? "")).toBeLessThanOrEqual(
          Math.max(CORPUS_QUERY_LEAF_BUDGET, baselineGroups.length),
        );
        if (countLeaves(baseline) >= CORPUS_QUERY_LEAF_BUDGET) {
          expect(candidate).toBe(baseline);
        }
      },
    ),
    propertyConfig(),
  );
  expect(svkFreeText("premlčanie", { stemming: null })).toBe(
    corpusFreeTextClause("premlčanie"),
  );
});

test("declared Slovak compatibility works even without an index jurisdiction clause", () => {
  const text = "premlčanie";
  const sharedIndexQuery = caseLawCorpusQuery({
    text,
    jurisdiction: "SVK",
    filters: { jurisdiction: "SVK" },
    stemming: SK_STEMMING,
    legacyStemming: caseLawCorpusQueryFields({
      generation: "case_law_v7",
      jurisdiction: "SVK",
      language: undefined,
    }).legacyStemming,
  });
  const singleJurisdictionQuery = caseLawCorpusQuery({
    text,
    jurisdiction: "SVK",
    filters: {},
    stemming: SK_STEMMING,
    legacyStemming: caseLawCorpusQueryFields({
      generation: "case_law_v7",
      jurisdiction: "SVK",
      language: undefined,
    }).legacyStemming,
  });
  if (singleJurisdictionQuery === null) {
    panic("Searchable Slovak test terms must produce a query");
  }
  expect(svkFreeText(text, { stemming: SK_STEMMING })).toBe(
    singleJurisdictionQuery,
  );
  expect(singleJurisdictionQuery).toContain('text_stem:"premlčani"');
  expect(singleJurisdictionQuery).toContain('headnote_stem:"premlčani"');
  expect(sharedIndexQuery).toBe(
    `${singleJurisdictionQuery} AND jurisdiction:"SVK"`,
  );
  const baseline = corpusFreeTextClause(text, { stemming: SK_STEMMING });
  if (baseline === null) {
    panic("Searchable Slovak test terms must produce a baseline clause");
  }
  for (const jurisdiction of ["CZE", undefined]) {
    expect(
      caseLawCorpusQuery({
        text,
        jurisdiction,
        filters: { jurisdiction: "SVK" },
        stemming: SK_STEMMING,
      }),
    ).toBe(`${baseline} AND jurisdiction:"SVK"`);
  }
});

const PROVISION_VARIANT_OPTIONS = {
  queryVariant: "provision-refs",
  stemming: SK_STEMMING,
  surfaceFields: ["headnote"],
  functionWords: functionWordsFor("sk"),
} as const satisfies CorpusFreeTextOptions;

test("a Slovak civil-code provision groups titles, aliases and all profile work identities", () => {
  expect(
    svkFreeText(
      "§ 451 Občianskeho zákonníka bezdôvodné obohatenie",
      PROVISION_VARIANT_OPTIONS,
    ),
  ).toBe(
    '(("451" OR headnote:"451" OR text_stem:"451" OR headnote_stem:"451") AND ("Občianskeho zákonníka" OR "Občiansky zákonník" OR "Občianskom zákonníku" OR "Stredný občiansky zákonník" OR "Stredného občianskeho zákonníka" OR "Strednom občianskom zákonníku" OR headnote:"Občianskeho zákonníka" OR text_stem:"občianskeh zákonník" OR headnote_stem:"občianskeh zákonník" OR "OZ" OR "obč zák" OR "141 1950" OR "40 1964") AND ("bezdôvodné" OR headnote:"bezdôvodné" OR text_stem:"bezdôvodn" OR headnote_stem:"bezdôvodn") AND ("obohatenie" OR text_stem:"obohaten" OR headnote_stem:"obohaten"))',
  );
});

test("a longer provision query trims act alternatives before losing required stem coverage", () => {
  expect(
    svkFreeText(
      "§ 106 Občianskeho zákonníka premlčanie práva na náhradu škody",
      PROVISION_VARIANT_OPTIONS,
    ),
  ).toBe(
    '(("106" OR text_stem:"106" OR headnote_stem:"106") AND ("Občianskeho zákonníka" OR "Občiansky zákonník" OR "Občianskom zákonníku" OR "Stredný občiansky zákonník" OR "Stredného občianskeho zákonníka" OR "Strednom občianskom zákonníku" OR "OZ" OR "obč zák" OR "40 1964") AND ("premlčanie" OR text_stem:"premlčan" OR headnote_stem:"premlčan") AND ("práva" OR text_stem:"práv" OR headnote_stem:"práv") AND ("náhradu" OR text_stem:"náhrad" OR headnote_stem:"náhrad") AND ("škody" OR text_stem:"škod" OR headnote_stem:"škod"))',
  );
});

test("provision reservation that cannot preserve baseline stems falls back byte-identically", () => {
  const text = `§ 451 Občianskeho zákonníka ${Array.from({ length: 8 }, () => "premlčanie").join(" ")}`;
  expect(svkFreeText(text, PROVISION_VARIANT_OPTIONS)).toBe(
    svkFreeText(text, { stemming: SK_STEMMING, surfaceFields: ["headnote"] }),
  );
});

test("provision subdivisions and act lead-ins stop being separate requirements", () => {
  expect(
    svkFreeText("§ 106 ods. 1 zákona OZ", { queryVariant: "provision-refs" }),
  ).toBe(
    '("106" AND ("OZ" OR "Občiansky zákonník" OR "Občianskeho zákonníka" OR "Občianskom zákonníku" OR "obč zák" OR "40 1964"))',
  );
});

test.each([
  { jurisdiction: "SVK", language: "sk", query: "§ 1 zákona o priestupkoch" },
  { jurisdiction: "CZE", language: "cs", query: "§ 1 zákona o azylu" },
  { jurisdiction: "SVK", language: "sk", query: "§ 106 ods. 1 písm. a OZ" },
  { jurisdiction: "CZE", language: "cs", query: "§ 106 odst. 1 písm. a OZ" },
] as const)(
  "provision spans retain function words under the production policy (%j)",
  ({ jurisdiction, language, query }) => {
    const options = { jurisdiction, queryVariant: "provision-refs" } as const;
    const clause = corpusFreeTextClause(query, {
      ...options,
      functionWords: functionWordsFor(language),
    });
    expect(clause).toBe(corpusFreeTextClause(query, options));
    expect(clause).not.toBe(
      corpusFreeTextClause(query, {
        jurisdiction,
        functionWords: functionWordsFor(language),
      }),
    );
  },
);

test("profile spellings form act groups with production function-word sets", () => {
  for (const jurisdiction of ["CZE", "SVK"] as const) {
    const profile = PROVISION_CITATION_PROFILES[jurisdiction];
    const functionWords = functionWordsFor(
      jurisdiction === "CZE" ? "cs" : "sk",
    );
    for (const entry of [...profile.titles, ...profile.aliases]) {
      if ("unit" in entry && entry.unit === "article") {
        continue;
      }
      for (const spelling of entry.spellings) {
        const clause =
          corpusFreeTextClause(`na § 451 ${spelling} a škody`, {
            jurisdiction,
            queryVariant: "provision-refs",
            functionWords,
          }) ?? panic("Profile spellings must produce a clause");
        const groups = clauseGroups(clause);
        expect(groups).toHaveLength(3);
        expect(groups.at(0)).toBe('"451"');
        expect(groups.at(1)).toContain(
          quoteCorpusValue(
            tokenizeCorpusFreeText(spelling)
              .map(({ value }) => value)
              .join(" "),
          ),
        );
        expect(groups.at(1)).toContain(" OR ");
        expect(groups.at(2)).toBe('"škody"');
      }
    }
  }
});

test("tight act budgets drop predecessor numbers before headnote stems and current act numbers", () => {
  const query = (
    count: number,
    options: CorpusFreeTextOptions = PROVISION_VARIANT_OPTIONS,
  ) =>
    svkFreeText(
      `§ 451 Občianskeho zákonníka ${Array.from({ length: count }, () => "súd").join(" ")}`,
      options,
    ) ?? panic("Expected a provision clause");
  const oneDrop =
    clauseGroups(query(3)).at(1) ?? panic("Expected an act group");
  expect(oneDrop).not.toContain('"141 1950"');
  expect(oneDrop).toContain('headnote_stem:"občianskeh zákonník"');
  expect(oneDrop).toContain('"40 1964"');
  const fourDrops =
    clauseGroups(query(4)).at(1) ?? panic("Expected an act group");
  expect(fourDrops).not.toContain("_stem:");
  expect(fourDrops).not.toContain("headnote:");
  expect(fourDrops).toContain('"Strednom občianskom zákonníku"');
  const titlesTrimmed =
    clauseGroups(query(5)).at(1) ?? panic("Expected an act group");
  expect(titlesTrimmed).not.toContain("Stredn");
  expect(titlesTrimmed).toContain('"Občianskom zákonníku"');
  expect(titlesTrimmed).toContain('"40 1964"');
  expect(clauseGroups(query(6)).at(1)).toBe(
    '("Občianskeho zákonníka" OR "OZ" OR "obč zák")',
  );
  expect(
    clauseGroups(query(21, { queryVariant: "provision-refs" })).at(1),
  ).toBe('("Občianskeho zákonníka" OR "OZ")');
  expect(
    clauseGroups(query(22, { queryVariant: "provision-refs" })).at(1),
  ).toBe('"Občianskeho zákonníka"');
  for (const count of [3, 4, 5, 6]) {
    expect(countLeaves(query(count))).toBe(CORPUS_QUERY_LEAF_BUDGET);
  }
});

test("multiple act groups share the same drop priority before either loses titles", () => {
  const clause =
    svkFreeText(
      "§ 451 Občianskeho zákonníka § 106 Občianskeho zákonníka",
      PROVISION_VARIANT_OPTIONS,
    ) ?? panic("Expected two provision groups");
  const groups = clauseGroups(clause);
  for (const index of [1, 3]) {
    const act = groups.at(index) ?? panic("Expected an act group");
    expect(act).not.toContain('"141 1950"');
    expect(act).not.toContain("_stem:");
    expect(act).not.toContain("headnote:");
    expect(act).toContain('"40 1964"');
    expect(act).toContain('"Strednom občianskom zákonníku"');
  }
  expect(countLeaves(clause)).toBe(CORPUS_QUERY_LEAF_BUDGET);
});

test("provision spans read the registry's profile for exactly the jurisdictions it holds", () => {
  const tokens = tokenizeCorpusFreeText("§ 106 OZ");
  const partitionFor = (
    queryVariant: CorpusIndexQueryVariant,
    jurisdiction: string | undefined,
  ) =>
    partitionCorpusQueryTokens({
      tokens,
      functionWords: null,
      queryVariant,
      jurisdiction,
    }).profile;
  for (const queryVariant of CORPUS_INDEX_QUERY_VARIANTS) {
    const { provisions } = CORPUS_QUERY_VARIANT_POLICY[queryVariant];
    for (const [jurisdiction, profile] of Object.entries(
      PROVISION_CITATION_PROFILES,
    )) {
      expect(partitionFor(queryVariant, jurisdiction)).toBe(
        provisions ? profile : null,
      );
    }
    for (const jurisdiction of ["POL", "EU", "cze", undefined]) {
      expect(partitionFor(queryVariant, jurisdiction)).toBeNull();
    }
  }
});
