import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, test } from "bun:test";
import type { Static } from "elysia";

import type { SearchTotal } from "@stll/api-contract/search";

import { searchTotalSchema } from "@/api/lib/search/total-schema";

describe("search total response schema", () => {
  test("matches the shared contract", () => {
    expectTypeOf<
      Static<typeof searchTotalSchema>
    >().toEqualTypeOf<SearchTotal>();
  });

  test.each([
    { type: "exact", count: 0 },
    { type: "estimate", count: 12 },
    { type: "not_counted" },
  ])("accepts a declared branch", (total) => {
    expect(Value.Check(searchTotalSchema, total)).toBe(true);
  });

  test.each([
    null,
    { type: "exact" },
    { type: "exact", count: -1 },
    { type: "estimate", count: 1.5 },
    { type: "estimate", count: Number.MAX_SAFE_INTEGER + 1 },
    { type: "not_counted", count: 0 },
  ])("rejects an ambiguous or invalid total", (total) => {
    expect(Value.Check(searchTotalSchema, total)).toBe(false);
  });
});
