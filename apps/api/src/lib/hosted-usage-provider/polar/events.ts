/**
 * Translates Polar's native webhook events into the provider-neutral
 * event contract consumed by `dispatch.ts`.
 *
 * Polar emits `subscription.*` and `order.*` events whose `data` is a
 * Polar `Subscription` / `Order` object. The neutral contract
 * (`event-schemas.ts`) expects `entitlement.*` / `allocation.*` events
 * with `account_ref` / `policy_ref` fields. Only the event name and three
 * field names differ; every other field name already matches, so this
 * module reshapes rather than re-validates — the strict neutral schema in
 * `event-schemas.ts` validates the result.
 *
 * Field map (Polar Subscription -> neutral entitlement payload):
 *   customer_id  -> account_ref      product_id -> policy_ref
 *   seats        -> quantity         (all other fields keep their names)
 *
 * Lifecycle map:
 *   subscription.created                 -> entitlement.created
 *   subscription.active                  -> entitlement.active
 *   subscription.updated|past_due|       -> entitlement.updated
 *     uncanceled
 *   subscription.canceled                -> entitlement.canceled  (scheduled; cancel_at_period_end)
 *   subscription.revoked                 -> entitlement.revoked    (immediate)
 *   order.paid (one-time purchase only)  -> allocation.created     (add-on credit pack)
 *
 * Subscription renewal orders are intentionally ignored: the matching
 * `subscription.*` event already owns the period and its idempotent
 * periodic allocation, so mapping renewal orders to allocations would
 * double-grant.
 */

import type { NormalizedProviderEvent } from "@/api/lib/hosted-usage-provider/provider-event-normalizer";
import { isRecord } from "@/api/lib/type-guards";

/** Polar subscription/order event types this adapter maps. */
export const POLAR_HANDLED_EVENT_TYPES = [
  "subscription.created",
  "subscription.active",
  "subscription.updated",
  "subscription.past_due",
  "subscription.uncanceled",
  "subscription.canceled",
  "subscription.revoked",
  "order.paid",
] as const;

const ignored = (raw: unknown): NormalizedProviderEvent => ({
  candidate: raw,
  handled: false,
});

const handledEntitlement = (
  type: string,
  data: Record<string, unknown>,
): NormalizedProviderEvent => ({
  candidate: {
    type,
    data: {
      id: data["id"],
      status: data["status"],
      account_ref: data["customer_id"],
      policy_ref: data["product_id"],
      current_period_start: data["current_period_start"],
      current_period_end: data["current_period_end"],
      cancel_at_period_end: data["cancel_at_period_end"],
      metadata: data["metadata"],
      // Polar `seats` is null for non-seat subscriptions; omit it so the
      // neutral schema/dispatch default of one seat applies. Seat-based
      // subscriptions carry a positive integer.
      quantity: typeof data["seats"] === "number" ? data["seats"] : undefined,
    },
  },
  handled: true,
});

const handledAllocation = (
  data: Record<string, unknown>,
): NormalizedProviderEvent => ({
  candidate: {
    type: "allocation.created",
    data: {
      id: data["id"],
      account_ref: data["customer_id"],
      policy_ref: data["product_id"],
      // dispatch only acts on add-on allocations; one-time purchase orders
      // are exactly that.
      allocation_reason: "addon",
      amount:
        typeof data["net_amount"] === "number" ? data["net_amount"] : undefined,
      currency: data["currency"],
      metadata: data["metadata"],
    },
  },
  handled: true,
});

// A one-time purchase has billing_reason "purchase" and no parent
// subscription; renewal orders carry a subscription_id and a
// subscription_* billing reason.
const isOneTimePurchase = (data: Record<string, unknown>): boolean =>
  data["billing_reason"] === "purchase" && data["subscription_id"] == null;

export const normalizePolarEvent = (
  raw: unknown,
  nativeType: string,
): NormalizedProviderEvent => {
  // `data` may be absent on a malformed delivery. For a handled
  // subscription type we still mark the event handled and reshape an empty
  // object: the strict neutral schema then rejects it and `receive.ts`
  // returns 400 so the provider retries, rather than silently acking a
  // broken event we were meant to act on.
  const data = isRecord(raw) && isRecord(raw["data"]) ? raw["data"] : null;
  switch (nativeType) {
    case "subscription.created":
      return handledEntitlement("entitlement.created", data ?? {});
    case "subscription.active":
      return handledEntitlement("entitlement.active", data ?? {});
    case "subscription.updated":
    case "subscription.past_due":
    case "subscription.uncanceled":
      return handledEntitlement("entitlement.updated", data ?? {});
    case "subscription.canceled":
      return handledEntitlement("entitlement.canceled", data ?? {});
    case "subscription.revoked":
      return handledEntitlement("entitlement.revoked", data ?? {});
    case "order.paid":
      return data && isOneTimePurchase(data)
        ? handledAllocation(data)
        : ignored(raw);
    default:
      return ignored(raw);
  }
};
