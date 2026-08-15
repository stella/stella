import { expect, test } from "bun:test";

import {
  caseLawCorpusQuery,
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
    caseLawCorpusQuery('"náhrada škody"', {
      court: "Nejvyšší soud",
      dateFrom: "2020-01-01",
      dateTo: "2024-12-31",
      documentType: "rozsudek",
      language: "cs",
      source: "7449df27-2067-4827-b22f-3091f564ae50",
    }),
  ).toBe(
    '("náhrada škody")' +
      ' AND document_type:"rozsudek"' +
      ' AND source:"7449df27-2067-4827-b22f-3091f564ae50"' +
      ' AND language:"cs"' +
      ' AND court:"Nejvyšší soud"' +
      " AND decision_date:[2020-01-01 TO 2024-12-31]",
  );
});

test("an open-ended date range keeps the wildcard bound", () => {
  expect(caseLawCorpusQuery("smlouva", { dateFrom: "2020-01-01" })).toBe(
    '("smlouva") AND decision_date:[2020-01-01 TO *]',
  );
  expect(caseLawCorpusQuery("smlouva", { dateTo: "2020-01-01" })).toBe(
    '("smlouva") AND decision_date:[* TO 2020-01-01]',
  );
});

test("no filters leaves the free-text clause alone", () => {
  expect(caseLawCorpusQuery("smlouva", {})).toBe('("smlouva")');
});

test("text without a searchable term yields no query", () => {
  expect(caseLawCorpusQuery("?!()", { court: "Nejvyšší soud" })).toBeNull();
  expect(caseLawCorpusQuery('""', {})).toBeNull();
});

// A filter value reaching the engine unescaped would let a caller that does
// not validate its inputs (the provider takes them straight from its caller)
// close the clause and append DSL of its own.
test("filter values cannot close their clause", () => {
  expect(caseLawCorpusQuery("smlouva", { court: 'X" OR text:*' })).toBe(
    '("smlouva") AND court:"X\\" OR text:*"',
  );
  expect(caseLawCorpusQuery("smlouva", { language: "cs\\" })).toBe(
    '("smlouva") AND language:"cs\\\\"',
  );
});
