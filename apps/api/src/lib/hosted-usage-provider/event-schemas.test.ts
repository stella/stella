import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  hostedUsageWebhookEventSchema,
  type HostedUsageEntitlementPayload,
} from "./event-schemas";
import { POLAR_ENTITLEMENT_STATUSES } from "./polar/contract";

const entitlement = {
  id: "entitlement-1",
  status: "active",
  account_ref: "account-1",
  policy_ref: "policy-1",
  current_period_start: "2026-06-01T00:00:00Z",
  current_period_end: "2026-07-01T00:00:00Z",
} satisfies HostedUsageEntitlementPayload;

describe("hosted entitlement period boundary", () => {
  for (const type of ["entitlement.created", "entitlement.active"]) {
    for (const status of [...POLAR_ENTITLEMENT_STATUSES, "unknown"]) {
      test(`${type} requires an end bound for ${status}`, () => {
        const event = { type, data: { ...entitlement, status } };
        expect(v.safeParse(hostedUsageWebhookEventSchema, event).success).toBe(
          true,
        );
        expect(
          v.safeParse(hostedUsageWebhookEventSchema, {
            ...event,
            data: { ...event.data, current_period_end: null },
          }).success,
        ).toBe(false);
      });
    }
  }

  const updatedNullEndDisposition = {
    incomplete: false,
    incomplete_expired: true,
    trialing: false,
    active: false,
    past_due: false,
    canceled: true,
    unpaid: false,
    paused: true,
  } as const satisfies Record<
    (typeof POLAR_ENTITLEMENT_STATUSES)[number],
    boolean
  >;

  for (const status of POLAR_ENTITLEMENT_STATUSES) {
    test(`updated ${status} accepts a null end only for a closed snapshot`, () => {
      const event = {
        type: "entitlement.updated",
        data: { ...entitlement, status },
      };
      expect(v.safeParse(hostedUsageWebhookEventSchema, event).success).toBe(
        true,
      );
      expect(
        v.safeParse(hostedUsageWebhookEventSchema, {
          ...event,
          data: { ...event.data, current_period_end: null },
        }).success,
      ).toBe(updatedNullEndDisposition[status]);
    });
  }

  test("updated unknown status requires an end bound", () => {
    expect(
      v.safeParse(hostedUsageWebhookEventSchema, {
        type: "entitlement.updated",
        data: { ...entitlement, status: "unknown", current_period_end: null },
      }).success,
    ).toBe(false);
  });

  for (const type of [
    "entitlement.paused",
    "entitlement.canceled",
    "entitlement.revoked",
    "entitlement.reconciliation",
  ]) {
    test(`${type} preserves a null end for its closed or reconciliation snapshot`, () => {
      const event = {
        type,
        data: { ...entitlement, status: "unknown", current_period_end: null },
      };
      const result = v.safeParse(hostedUsageWebhookEventSchema, event);
      expect(result.success).toBe(true);
      expect(result.output).toEqual(event);
    });
  }
});
