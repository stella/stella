import { expect, test } from "bun:test";

import { localeInputText } from "@stll/money";

import { deriveTimeEntryPricing } from "./time-entry-pricing.logic";

const typed = (value: string) => localeInputText({ value, tagName: "INPUT" });

test("a manual rate the currency cannot hold blocks submission instead of saving zero", () => {
  const pricing = deriveTimeEntryPricing({
    selection: { type: "manual", draft: typed("100.50"), currency: "JPY" },
    lookup: undefined,
    locale: "en-US",
  });
  expect(pricing.status).toBe("invalid");
});

test("a manual rate kept through a currency change keeps its whole units", () => {
  const pricing = deriveTimeEntryPricing({
    selection: { type: "manual", draft: typed("100.00"), currency: "JPY" },
    lookup: { status: "success", fetchStatus: "idle", data: undefined },
    locale: "en-US",
  });
  expect(pricing).toEqual({
    status: "ready",
    rateAtEntry: 100,
    currency: "JPY",
  });
});
