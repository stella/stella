import { describe, expect, expectTypeOf, test } from "bun:test";
import * as v from "valibot";

import type { SearchTotal } from "@stll/api-contract/search";

import { searchTotalSchema } from "@/api/lib/search/total-schema";

describe("search total response schema", () => {
  test("matches the shared contract", () => {
    expectTypeOf<
      v.InferOutput<typeof searchTotalSchema>
    >().toEqualTypeOf<SearchTotal>();
  });

  test.each([
    { type: "exact", count: 0 },
    { type: "estimate", count: 12 },
    { type: "not_counted" },
  ])("accepts a declared branch", (total) => {
    expect(v.is(searchTotalSchema, total)).toBe(true);
  });

  test.each([
    null,
    { type: "exact" },
    { type: "exact", count: -1 },
    { type: "exact", count: "12" },
    { type: "estimate", count: "0".repeat(10_000) },
    { type: "estimate", count: 1.5 },
    { type: "estimate", count: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects an ambiguous or invalid total", (total) => {
    expect(v.is(searchTotalSchema, total)).toBe(false);
  });

  test("an uncounted total never carries a count on the wire", () => {
    // A response is sent as its schema's output, so a count beside
    // `not_counted` is dropped rather than read as a number.
    expect(
      v.parse(searchTotalSchema, { type: "not_counted", count: 0 }),
    ).toEqual({ type: "not_counted" });
  });
});
