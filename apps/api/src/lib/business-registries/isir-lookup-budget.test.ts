import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  ISIR_LOOKUP_DAILY_REQUESTS,
  ISIR_LOOKUP_REFUSAL,
  ISIR_LOOKUP_REQUESTS,
  type IsirLookupBudgetDependencies,
  reserveIsirLookup,
} from "@/api/lib/business-registries/isir-lookup-budget";

/** A shared day counter and a slot ledger, as the deployed store keeps them. */
const ledger = (spentAlready = 0) => {
  const days = new Map<string, number>([["2026-11-20", spentAlready]]);
  const slots: number[] = [];
  const dependencies: IsirLookupBudgetDependencies = {
    reserves: () => true,
    takeFromDay: async (day, requests, limit) => {
      const used = (days.get(day) ?? 0) + requests;
      if (used > limit) {
        return await Promise.resolve(false);
      }
      days.set(day, used);
      return await Promise.resolve(true);
    },
    reserveSlot: async () => {
      slots.push(slots.length);
      await Promise.resolve();
    },
    today: () => "2026-11-20",
  };
  return { days, slots, dependencies };
};

describe("reserveIsirLookup", () => {
  test("a lookup takes its requests from the day and a slot for each", async () => {
    const { days, slots, dependencies } = ledger();
    expect(Result.isOk(await reserveIsirLookup(undefined, dependencies))).toBe(
      true,
    );
    expect(days.get("2026-11-20")).toBe(ISIR_LOOKUP_REQUESTS);
    expect(slots).toHaveLength(ISIR_LOOKUP_REQUESTS);
  });

  test("the day's budget, with the corpus walk's share, stays under the register's limits", () => {
    // The walk's gate: one request every 40 s.
    const walkPerDay = 86_400 / 40;
    expect(walkPerDay + ISIR_LOOKUP_DAILY_REQUESTS).toBeLessThan(3000);
  });

  test("a lookup the day cannot pay for is refused, and asks for no slot", async () => {
    const { slots, dependencies } = ledger(
      ISIR_LOOKUP_DAILY_REQUESTS - ISIR_LOOKUP_REQUESTS + 1,
    );
    const refused = await reserveIsirLookup(undefined, dependencies);
    expect(Result.isError(refused) && refused.error.reason).toBe(
      ISIR_LOOKUP_REFUSAL.SPENT,
    );
    expect(slots).toEqual([]);
  });

  test("a counter that cannot be read sends nothing", async () => {
    const { slots, dependencies } = ledger();
    const refused = await reserveIsirLookup(undefined, {
      ...dependencies,
      takeFromDay: async () => await Promise.reject(new Error("store down")),
    });
    expect(Result.isError(refused) && refused.error.reason).toBe(
      ISIR_LOOKUP_REFUSAL.UNAVAILABLE,
    );
    expect(slots).toEqual([]);
  });
});
