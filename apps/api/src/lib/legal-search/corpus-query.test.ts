import { expect, test } from "bun:test";

import {
  CORPUS_QUERY_LEAF_BUDGET,
  caseLawCorpusQuery,
  type CorpusStemming,
  corpusFreeTextClause,
  quoteCorpusValue,
  tokenizeCorpusFreeText,
} from "@/api/lib/legal-search/corpus-query";

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
      ' AND document_type:"rozsudek"' +
      ' AND source:"7449df27-2067-4827-b22f-3091f564ae50"' +
      ' AND language:"cs"' +
      ' AND court:"Nejvyšší soud"' +
      " AND decision_date:[2020-01-01 TO 2024-12-31]",
  );
});

test("an open-ended date range keeps the wildcard bound", () => {
  expect(
    caseLawCorpusQuery({
      text: "smlouva",
      filters: { dateFrom: "2020-01-01" },
    }),
  ).toBe('("smlouva") AND decision_date:[2020-01-01 TO *]');
  expect(
    caseLawCorpusQuery({
      text: "smlouva",
      filters: { dateTo: "2020-01-01" },
    }),
  ).toBe('("smlouva") AND decision_date:[* TO 2020-01-01]');
});

test("no filters leaves the free-text clause alone", () => {
  expect(caseLawCorpusQuery({ text: "smlouva", filters: {} })).toBe(
    '("smlouva")',
  );
});

test("text without a searchable term yields no query", () => {
  expect(
    caseLawCorpusQuery({
      text: "?!()",
      filters: { court: "Nejvyšší soud" },
    }),
  ).toBeNull();
  expect(caseLawCorpusQuery({ text: '""', filters: {} })).toBeNull();
});

// A filter value reaching the engine unescaped would let a caller that does
// not validate its inputs (the provider takes them straight from its caller)
// close the clause and append DSL of its own.
test("filter values cannot close their clause", () => {
  expect(
    caseLawCorpusQuery({
      text: "smlouva",
      filters: { court: 'X" OR text:*' },
    }),
  ).toBe('("smlouva") AND court:"X\\" OR text:*"');
  expect(
    caseLawCorpusQuery({
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
    text: "nájemního",
    filters: { jurisdiction: "CZE" },
    surfaceFields: ["headnote"],
    stemming: CS_STEMMING,
  });

  expect(decisions).toContain('headnote:"nájemního"');
  expect(decisions).toContain('headnote_stem:"nájemn"');
  // The same query for a generation that maps neither is what it is today.
  expect(
    caseLawCorpusQuery({ text: "nájemního", filters: { jurisdiction: "CZE" } }),
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

test("a generation without extra fields gets the query it gets today", () => {
  for (const text of [
    "náhrada škody",
    '"dobrá víra" a "náhrada škody"',
    "§ 2235 odst. 1",
  ]) {
    expect(
      corpusFreeTextClause(text, { stemming: null, surfaceFields: [] }),
    ).toBe(corpusFreeTextClause(text));
    expect(caseLawCorpusQuery({ text, filters: { jurisdiction: "CZE" } })).toBe(
      caseLawCorpusQuery({
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
