import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { buildUsagePolicyCatalogEntry } from "./policy-catalog";

const BASE_ROW = {
  id: toSafeId<"usagePolicy">("usage_policy_catalog_test"),
  key: "catalog-test",
  displayName: "Catalog test",
  description: null,
  kind: "subscription",
  monthlyUsageUnits: 1000,
  priceAmountCents: null,
  priceCurrency: null,
  billingInterval: null,
  sortOrder: 0,
  hostedPolicyRef: null,
} as const satisfies Parameters<typeof buildUsagePolicyCatalogEntry>[0];

describe("usage policy catalog entry", () => {
  test("represents an absent price as one null state", () => {
    expect(buildUsagePolicyCatalogEntry(BASE_ROW, true)).toMatchObject({
      price: null,
    });
  });

  test("represents a complete price as one object", () => {
    expect(
      buildUsagePolicyCatalogEntry(
        {
          ...BASE_ROW,
          priceAmountCents: 2500,
          priceCurrency: "EUR",
          billingInterval: "month",
        },
        true,
      ),
    ).toMatchObject({
      price: {
        amountCents: 2500,
        currency: "EUR",
        billingInterval: "month",
      },
    });
  });

  for (const price of [
    {
      priceAmountCents: 2500,
      priceCurrency: null,
      billingInterval: null,
    },
    {
      priceAmountCents: null,
      priceCurrency: "EUR",
      billingInterval: null,
    },
    {
      priceAmountCents: null,
      priceCurrency: null,
      billingInterval: "month",
    },
    {
      priceAmountCents: 2500,
      priceCurrency: "EUR",
      billingInterval: null,
    },
    {
      priceAmountCents: 2500,
      priceCurrency: null,
      billingInterval: "month",
    },
    {
      priceAmountCents: null,
      priceCurrency: "EUR",
      billingInterval: "month",
    },
  ] as const) {
    test(`rejects incomplete price ${JSON.stringify(price)}`, () => {
      expect(() =>
        buildUsagePolicyCatalogEntry({ ...BASE_ROW, ...price }, true),
      ).toThrow("Usage policy has incomplete catalog price fields");
    });
  }

  test("distinguishes provider, policy, and available checkout states", () => {
    expect(
      buildUsagePolicyCatalogEntry(
        { ...BASE_ROW, hostedPolicyRef: "hosted_policy" },
        false,
      ).hostedCheckout,
    ).toEqual({
      status: "unavailable",
      reason: "provider_unavailable",
    });
    expect(buildUsagePolicyCatalogEntry(BASE_ROW, true).hostedCheckout).toEqual(
      {
        status: "unavailable",
        reason: "policy_unavailable",
      },
    );
    expect(
      buildUsagePolicyCatalogEntry(
        { ...BASE_ROW, hostedPolicyRef: "hosted_policy" },
        true,
      ).hostedCheckout,
    ).toEqual({ status: "available" });
  });
});
