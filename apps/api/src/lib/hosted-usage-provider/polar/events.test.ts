import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { hostedUsageWebhookEventSchema } from "@/api/handlers/hosted-usage-webhook/event-schemas";
import { normalizePolarEvent } from "@/api/lib/hosted-usage-provider/polar/events";
import { normalizeProviderEvent } from "@/api/lib/hosted-usage-provider/provider-event-normalizer";

const polarSubscription = (overrides: Record<string, unknown> = {}) => ({
  id: "sub_123",
  status: "active",
  customer_id: "cus_abc",
  product_id: "prod_pro",
  current_period_start: "2026-06-01T00:00:00Z",
  current_period_end: "2026-07-01T00:00:00Z",
  cancel_at_period_end: false,
  seats: 3,
  metadata: {
    organization_id: "org_1",
    usage_policy_id: "pol_1",
    seat_user_id: "user_1",
  },
  ...overrides,
});

const polarOrder = (overrides: Record<string, unknown> = {}) => ({
  id: "ord_1",
  status: "paid",
  paid: true,
  billing_reason: "purchase",
  net_amount: 5000,
  currency: "usd",
  customer_id: "cus_abc",
  product_id: "prod_pack",
  subscription_id: null,
  metadata: { organization_id: "org_1", usage_policy_id: "pol_pack" },
  ...overrides,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const expectRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error("candidate was not an object");
  }
  return value;
};

describe("normalizePolarEvent — subscription lifecycle", () => {
  const cases = [
    { native: "subscription.created", neutral: "entitlement.created" },
    { native: "subscription.active", neutral: "entitlement.active" },
    { native: "subscription.updated", neutral: "entitlement.updated" },
    { native: "subscription.past_due", neutral: "entitlement.updated" },
    { native: "subscription.uncanceled", neutral: "entitlement.updated" },
    { native: "subscription.canceled", neutral: "entitlement.canceled" },
    { native: "subscription.revoked", neutral: "entitlement.revoked" },
  ] as const;

  for (const { native, neutral } of cases) {
    test(`${native} -> ${neutral}, renames fields, validates against neutral schema`, () => {
      const data = polarSubscription();
      const result = normalizePolarEvent({ type: native, data }, native);

      expect(result.handled).toBe(true);
      const candidate = expectRecord(result.candidate);
      expect(candidate["type"]).toBe(neutral);
      const mapped = expectRecord(candidate["data"]);
      expect(mapped["account_ref"]).toBe("cus_abc");
      expect(mapped["policy_ref"]).toBe("prod_pro");
      expect(mapped["quantity"]).toBe(3);
      expect(mapped["current_period_start"]).toBe("2026-06-01T00:00:00Z");
      expect(mapped["cancel_at_period_end"]).toBe(false);

      // The mapped candidate must satisfy the strict neutral schema that
      // dispatch.ts relies on; this is the contract the whole binding hangs on.
      expect(
        v.safeParse(hostedUsageWebhookEventSchema, result.candidate).success,
      ).toBe(true);
    });
  }

  test("omits quantity when Polar seats is null so dispatch defaults to one", () => {
    const result = normalizePolarEvent(
      { type: "subscription.active", data: polarSubscription({ seats: null }) },
      "subscription.active",
    );
    const mapped = expectRecord(expectRecord(result.candidate)["data"]);
    expect(mapped["quantity"]).toBeUndefined();
    expect(
      v.safeParse(hostedUsageWebhookEventSchema, result.candidate).success,
    ).toBe(true);
  });

  test("a handled subscription event with no data stays handled (forces 400/retry)", () => {
    const result = normalizePolarEvent(
      { type: "subscription.active" },
      "subscription.active",
    );
    expect(result.handled).toBe(true);
    expect(
      v.safeParse(hostedUsageWebhookEventSchema, result.candidate).success,
    ).toBe(false);
  });
});

describe("normalizePolarEvent — orders", () => {
  test("one-time purchase order.paid -> allocation.created (addon)", () => {
    const result = normalizePolarEvent(
      { type: "order.paid", data: polarOrder() },
      "order.paid",
    );
    expect(result.handled).toBe(true);
    const candidate = expectRecord(result.candidate);
    expect(candidate["type"]).toBe("allocation.created");
    const mapped = expectRecord(candidate["data"]);
    expect(mapped["allocation_reason"]).toBe("addon");
    expect(mapped["account_ref"]).toBe("cus_abc");
    expect(mapped["policy_ref"]).toBe("prod_pack");
    expect(mapped["amount"]).toBe(5000);
    expect(
      v.safeParse(hostedUsageWebhookEventSchema, result.candidate).success,
    ).toBe(true);
  });

  test("subscription renewal order.paid is ignored (subscription.* owns the period)", () => {
    const result = normalizePolarEvent(
      {
        type: "order.paid",
        data: polarOrder({
          billing_reason: "subscription_cycle",
          subscription_id: "sub_123",
        }),
      },
      "order.paid",
    );
    expect(result.handled).toBe(false);
  });
});

describe("normalizePolarEvent — unmapped events", () => {
  for (const native of [
    "customer.created",
    "checkout.updated",
    "benefit_grant.created",
    "order.refunded",
  ]) {
    test(`${native} is ignored and passed through unchanged`, () => {
      const raw = { type: native, data: { id: "x" } };
      const result = normalizePolarEvent(raw, native);
      expect(result.handled).toBe(false);
      expect(result.candidate).toBe(raw);
    });
  }
});

describe("normalizeProviderEvent — kind selection", () => {
  test("neutral kind passes the body through and mirrors the handled set", () => {
    const neutralEvent = {
      type: "entitlement.active",
      data: {
        id: "ent_1",
        status: "active",
        account_ref: "cus_abc",
        policy_ref: "prod_pro",
        current_period_start: "2026-06-01T00:00:00Z",
        current_period_end: "2026-07-01T00:00:00Z",
      },
    };
    const handled = normalizeProviderEvent(
      neutralEvent,
      "entitlement.active",
      "neutral",
    );
    expect(handled.candidate).toBe(neutralEvent);
    expect(handled.handled).toBe(true);

    const unknown = normalizeProviderEvent({ type: "x.y" }, "x.y", "neutral");
    expect(unknown.handled).toBe(false);
  });

  test("polar kind delegates to the Polar mapper", () => {
    const result = normalizeProviderEvent(
      { type: "subscription.revoked", data: polarSubscription() },
      "subscription.revoked",
      "polar",
    );
    expect(result.handled).toBe(true);
    expect(expectRecord(result.candidate)["type"]).toBe("entitlement.revoked");
  });
});
