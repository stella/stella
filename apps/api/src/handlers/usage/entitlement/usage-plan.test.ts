import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { usagePlanResponseSchema } from "@stll/api-contract/usage-plan";

import { projectUsagePlan } from "./usage-plan";

describe("usage exposes the resolved plan without internal budgets", () => {
  test("every managed standing returns only its discriminant", () => {
    for (const access of [
      { type: "paid", deadline: new Date(), serviceActionsPerPeriod: 3 },
      { type: "evaluation", endsAt: new Date() },
      { type: "free", serviceActionsPerPeriod: 3 },
    ] as const) {
      const result = projectUsagePlan(access);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({ plan: { type: access.type } });
        expect(v.safeParse(usagePlanResponseSchema, result.value).success).toBe(
          true,
        );
      }
    }
  });

  test("self-managed access has its own plan discriminant", () => {
    const result = projectUsagePlan({ type: "self_managed_keys" });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ plan: { type: "self_managed_keys" } });
    }
  });

  test("unresolved standings fail instead of inventing a plan", () => {
    for (const type of ["unavailable", "ended"] as const) {
      const result = projectUsagePlan({ type });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe("organization_access_unavailable");
      }
    }
  });

  test("the wire schema rejects hidden budget fields", () => {
    expect(
      v.safeParse(usagePlanResponseSchema, {
        plan: { type: "free", serviceActionsPerPeriod: 3 },
      }).success,
    ).toBe(false);
  });
});
