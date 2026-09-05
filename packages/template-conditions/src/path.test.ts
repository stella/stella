import { describe, expect, test } from "bun:test";

import { isRecord, resolvePath } from "./path";

describe("isRecord", () => {
  // Deliberately unlike the API's and business-registries' predicates of the
  // same name, which reject arrays because they screen JSON payload shapes.
  // Here the predicate gates a path walk, and a dotted path segment may be an
  // array index, so an array has to read as walkable.
  test("accepts an array, because a path segment may index one", () => {
    expect(isRecord([1, 2])).toBe(true);
  });

  test("rejects null and primitives", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord("company")).toBe(false);
    expect(isRecord(7)).toBe(false);
  });
});

describe("resolvePath", () => {
  test("prefers an exact dotted key over the nested form", () => {
    expect(
      resolvePath("company.name", {
        "company.name": "flat",
        company: { name: "nested" },
      }),
    ).toBe("flat");
  });

  test("walks nested records", () => {
    expect(resolvePath("company.name", { company: { name: "nested" } })).toBe(
      "nested",
    );
  });

  test("walks an array index", () => {
    expect(
      resolvePath("parties.1.name", {
        parties: [{ name: "first" }, { name: "second" }],
      }),
    ).toBe("second");
  });

  test("stops at a primitive instead of throwing", () => {
    expect(resolvePath("company.name.first", { company: { name: "x" } })).toBe(
      undefined,
    );
  });
});
