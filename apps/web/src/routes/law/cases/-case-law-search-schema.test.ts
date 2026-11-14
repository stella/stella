import { expect, test } from "bun:test";
import * as v from "valibot";

import { decisionDateRange } from "@/features/case-law/case-law-index-search.logic";
import { parseRouteSearch } from "@/route-search-params";

import { searchSchema } from "./-case-law-search-schema";

test("a legacy year link opens that year's decisions", () => {
  const search = v.parse(
    searchSchema,
    parseRouteSearch("?court=%C3%9Astavn%C3%AD+soud&year=2026"),
  );
  expect(search.court).toBe("Ústavní soud");
  expect(decisionDateRange(search)).toEqual({
    from: "2026-01-01",
    to: "2026-12-31",
  });
});

test("number-like text stays the reader's text", () => {
  const search = v.parse(
    searchSchema,
    parseRouteSearch("?q=2026&court=123&type=1&lang=1&strict=1"),
  );
  expect(search).toMatchObject({
    court: "123",
    lang: "1",
    q: "2026",
    strict: "1",
    type: "1",
  });
});
