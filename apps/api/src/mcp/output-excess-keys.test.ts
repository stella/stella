import { describe, expect, expectTypeOf, test } from "bun:test";

import type { OutputExcessPaths } from "@/api/mcp/output-excess-keys";
import type { InternalToolResult, McpEgressPlan } from "@/api/mcp/tool-types";
import { structuredEgressPlan, toolDataResult } from "@/api/mcp/tool-utils";

type Bucket = { value: string; label: string | null; count: number };
type Declared = {
  facets: { source: Bucket[]; year: Bucket[] } | null;
  total: { type: "exact"; count: number } | { type: "not_counted" };
};

// What a search service returns: its source buckets carry a field the
// declared output does not.
type ServiceFacets = {
  source: (Bucket & { countType: "exact" | "estimate" })[];
  year: Bucket[];
};

describe("output excess paths", () => {
  test("names a nested field the declared output lacks", () => {
    expectTypeOf<
      OutputExcessPaths<
        { facets: ServiceFacets; total: { type: "not_counted" } },
        Declared
      >
    >().toEqualTypeOf<"output.facets.source[].countType">();
  });

  test("names a numeric key the declared output lacks", () => {
    expectTypeOf<
      OutputExcessPaths<{ 0: string }, Record<never, never>>
    >().toEqualTypeOf<"output.0">();
    expectTypeOf<OutputExcessPaths<{ 0: string }, { 0: string }>>().toBeNever();
  });

  test("accepts a value whose every field is declared", () => {
    expectTypeOf<
      OutputExcessPaths<
        { facets: null; total: { type: "exact"; count: number } },
        Declared
      >
    >().toBeNever();
  });

  test("reads each union member against the branch it fits", () => {
    expectTypeOf<
      OutputExcessPaths<{ type: "exact"; count: number }, Declared["total"]>
    >().toBeNever();
    // `count` belongs to the other branch, not to the one this value fits.
    expectTypeOf<
      OutputExcessPaths<
        { type: "not_counted"; count: number },
        Declared["total"]
      >
    >().toEqualTypeOf<"output.count">();
    expectTypeOf<
      OutputExcessPaths<
        { type: "not_counted"; reason: string },
        Declared["total"]
      >
    >().toEqualTypeOf<"output.reason">();
  });

  test("ignores a key that can only be absent", () => {
    expectTypeOf<
      OutputExcessPaths<
        { readonly entitlement: null; policy?: never },
        { entitlement: null } | { entitlement: string; policy: string }
      >
    >().toBeNever();
  });

  test("rejects an undeclared field at the checked constructors", () => {
    const facets: ServiceFacets = {
      source: [{ value: "s", label: null, count: 1, countType: "exact" }],
      year: [],
    };
    const handler = (): InternalToolResult<Declared> =>
      // @ts-expect-error -- source buckets carry `countType`, which Declared lacks
      toolDataResult({ facets, total: { type: "not_counted" } });
    const plan = (): Extract<
      McpEgressPlan<Declared>,
      { egress: "structured" }
    > =>
      structuredEgressPlan({
        // @ts-expect-error -- same undeclared field, through the egress plan
        payload: { facets, total: { type: "not_counted" } },
        textFields: [],
      });
    const untyped = () =>
      // @ts-expect-error -- no declared output type to check against
      toolDataResult({ facets: null });
    const declaredOnly = () =>
      // @ts-expect-error -- naming only the declared type would skip the check
      toolDataResult<Declared>({ facets, total: { type: "not_counted" } });

    expect(handler().status).toBe("success");
    expect(plan().egress).toBe("structured");
    expect(untyped().status).toBe("success");
    expect(declaredOnly().status).toBe("success");
  });
});
