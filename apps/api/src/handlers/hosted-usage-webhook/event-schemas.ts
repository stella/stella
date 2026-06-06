/**
 * Valibot schemas for the hosted usage webhook events we currently
 * handle. The provider emits a long tail of additional event types; we
 * accept the envelope of any event and only require strict shapes
 * for the events we act on. Unknown event types fall through to
 * `result: "ignored"` in the receive handler.
 *
 * Schemas use `v.looseObject` for the outer envelope so future
 * provider fields don't break ingest; the inner `data` payload for
 * the events we handle uses `v.object` (loose) with explicit
 * required fields plus `metadata` we attach at hosted setup time.
 */

import * as v from "valibot";

const ENTITLEMENT_CREATED_EVENT_TYPE = "entitlement.created";
const ENTITLEMENT_UPDATED_EVENT_TYPE = "entitlement.updated";
const ENTITLEMENT_ACTIVE_EVENT_TYPE = "entitlement.active";
const ENTITLEMENT_CANCELED_EVENT_TYPE = "entitlement.canceled";
const ENTITLEMENT_REVOKED_EVENT_TYPE = "entitlement.revoked";
const ALLOCATION_CREATED_EVENT_TYPE = "allocation.created";

export const HOSTED_USAGE_HANDLED_EVENT_TYPES = [
  ENTITLEMENT_CREATED_EVENT_TYPE,
  ENTITLEMENT_UPDATED_EVENT_TYPE,
  ENTITLEMENT_ACTIVE_EVENT_TYPE,
  ENTITLEMENT_CANCELED_EVENT_TYPE,
  ENTITLEMENT_REVOKED_EVENT_TYPE,
  ALLOCATION_CREATED_EVENT_TYPE,
] as const;

const HOSTED_USAGE_HANDLED_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  HOSTED_USAGE_HANDLED_EVENT_TYPES,
);

export const isHostedUsageHandledEventType = (eventType: string): boolean =>
  HOSTED_USAGE_HANDLED_EVENT_TYPE_SET.has(eventType);

const positiveIntSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const optionalStringSchema = v.optional(v.string());

const providerMetadataSchema = v.object({
  /**
   * Identifies the Stella organisation that initiated hosted setup.
   * We require this at hosted setup creation; webhooks that reference
   * an unknown / missing org_id are rejected upstream.
   */
  organization_id: optionalStringSchema,
  /**
   * Identifies the usage_policy row this hosted setup maps to.
   */
  usage_policy_id: optionalStringSchema,
  /**
   * Identifies the seat the allocation is attached to. Optional:
   * if unset the allocation goes to the org pool.
   */
  seat_user_id: optionalStringSchema,
});

const providerEntitlementSchema = v.object({
  id: v.string(),
  status: v.string(),
  account_ref: v.string(),
  policy_ref: v.string(),
  current_period_start: v.string(),
  current_period_end: v.string(),
  /**
   * True when the provider entitlement has been cancelled but is
   * still active until the end of the current entitlement period. Provider
   * events set this state; the local row's
   * `cancel_at_period_end` mirrors it so the UI can render a
   * graceful "Ends on <date>" state.
   */
  cancel_at_period_end: v.optional(v.boolean()),
  metadata: v.optional(providerMetadataSchema),
  quantity: v.optional(positiveIntSchema),
});

const providerAllocationSchema = v.object({
  id: v.string(),
  account_ref: v.string(),
  policy_ref: v.string(),
  allocation_reason: v.optional(v.string()),
  amount: v.optional(v.number()),
  currency: v.optional(v.string()),
  metadata: v.optional(providerMetadataSchema),
});

export const entitlementCreatedEventSchema = v.looseObject({
  type: v.literal(ENTITLEMENT_CREATED_EVENT_TYPE),
  data: providerEntitlementSchema,
});

export const entitlementUpdatedEventSchema = v.looseObject({
  type: v.literal(ENTITLEMENT_UPDATED_EVENT_TYPE),
  data: providerEntitlementSchema,
});

export const entitlementActiveEventSchema = v.looseObject({
  type: v.literal(ENTITLEMENT_ACTIVE_EVENT_TYPE),
  data: providerEntitlementSchema,
});

export const entitlementCanceledEventSchema = v.looseObject({
  type: v.literal(ENTITLEMENT_CANCELED_EVENT_TYPE),
  data: providerEntitlementSchema,
});

export const entitlementRevokedEventSchema = v.looseObject({
  type: v.literal(ENTITLEMENT_REVOKED_EVENT_TYPE),
  data: providerEntitlementSchema,
});

export const allocationCreatedEventSchema = v.looseObject({
  type: v.literal(ALLOCATION_CREATED_EVENT_TYPE),
  data: providerAllocationSchema,
});

export const hostedUsageWebhookEventSchema = v.variant("type", [
  entitlementCreatedEventSchema,
  entitlementUpdatedEventSchema,
  entitlementActiveEventSchema,
  entitlementCanceledEventSchema,
  entitlementRevokedEventSchema,
  allocationCreatedEventSchema,
]);

export type HostedUsageWebhookEvent = v.InferOutput<
  typeof hostedUsageWebhookEventSchema
>;
export type HostedUsageEntitlementPayload = v.InferOutput<
  typeof providerEntitlementSchema
>;
export type HostedUsageAllocationPayload = v.InferOutput<
  typeof providerAllocationSchema
>;

/**
 * Envelope schema for unknown event types — we still want to
 * extract `type` and `id` for dedup + logging, even when we don't
 * have a strict schema for the body.
 */
export const hostedUsageUnknownEventEnvelopeSchema = v.looseObject({
  type: v.string(),
});

export type HostedUsageEnvelope = v.InferOutput<
  typeof hostedUsageUnknownEventEnvelopeSchema
>;
