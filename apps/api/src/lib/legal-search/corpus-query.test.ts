import { expect, test } from "bun:test";

import { corpusFreeTextClause } from "@/api/lib/legal-search/corpus-query";

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
