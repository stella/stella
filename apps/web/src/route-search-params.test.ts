import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  parseRouteSearch,
  routeSearchSchema,
  stringifyRouteSearch,
} from "@/route-search-params";

describe("parseRouteSearch", () => {
  test("reads scalars as the URL's own text", () => {
    expect({
      ...parseRouteSearch("?year=2026&q=true&court=123&lang=null&x=1e3"),
    }).toEqual({
      court: "123",
      lang: "null",
      q: "true",
      x: "1e3",
      year: "2026",
    });
  });

  test("decodes the JSON the app writes", () => {
    expect({
      ...parseRouteSearch(
        `?questions=${encodeURIComponent('["a","b"]')}&q=${encodeURIComponent('"2026"')}&sizing=${encodeURIComponent('{"a":1}')}`,
      ),
    }).toEqual({ q: "2026", questions: ["a", "b"], sizing: { a: 1 } });
  });

  test("keeps text that only looks like JSON", () => {
    expect({ ...parseRouteSearch("?q=%5Bnot+json&r=%22") }).toEqual({
      q: "[not json",
      r: '"',
    });
  });

  test("keeps the first value of a repeated key", () => {
    expect({ ...parseRouteSearch("?q=a&q=b") }).toEqual({ q: "a" });
  });

  test("reads __proto__ as a plain key", () => {
    const search = parseRouteSearch("?__proto__=x");
    expect(Object.hasOwn(search, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(search)).toBe(Object.prototype);
  });
});

describe("stringifyRouteSearch", () => {
  test("round-trips every string, however it looks", () => {
    for (const text of [
      "2026",
      "true",
      "null",
      '"exact phrase"',
      "[1]",
      "{}",
      "[not json",
      "",
      "nájem 2026",
    ]) {
      expect(parseRouteSearch(stringifyRouteSearch({ q: text }))["q"]).toBe(
        text,
      );
    }
  });

  test("writes scalars plainly and skips undefined", () => {
    expect(
      stringifyRouteSearch({ done: true, page: 2, q: "2026", skip: undefined }),
    ).toBe("?done=true&page=2&q=2026");
  });

  test("round-trips lists and objects", () => {
    const search = { questions: ["a", "2"], sizing: { a: 1 } };
    expect({ ...parseRouteSearch(stringifyRouteSearch(search)) }).toEqual(
      search,
    );
  });

  test("writes nothing for an empty search", () => {
    expect(stringifyRouteSearch({})).toBe("");
  });
});

describe("routeSearchSchema", () => {
  const schema = routeSearchSchema({
    q: v.optional(v.pipe(v.string(), v.regex(/^\p{L}+$/u))),
    sort: v.optional(v.picklist(["newest", "oldest"]), "newest"),
  });

  test("reads the fields a URL carries", () => {
    expect(v.parse(schema, { q: "nájem", sort: "oldest" })).toEqual({
      q: "nájem",
      sort: "oldest",
    });
  });

  test("drops a value its field refuses and reads the field's default", () => {
    expect(v.parse(schema, { q: "x1", sort: "authority" })).toEqual({
      sort: "newest",
    });
    expect(v.parse(schema, { q: ["x"], sort: { a: 1 } })).toEqual({
      sort: "newest",
    });
  });

  test("ignores keys no field names", () => {
    expect(v.parse(schema, { q: "x", utm_source: "mail" })).toEqual({
      q: "x",
      sort: "newest",
    });
  });

  test("keeps its fields readable for a schema that extends it", () => {
    expect(Object.keys(schema.entries)).toEqual(["q", "sort"]);
  });
});
