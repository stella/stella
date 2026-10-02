import * as v from "valibot";

export const POLAR_API_VERSIONS = ["2026-04", "2026-10"] as const;
// The normalizer field mapping and fixtures target the 2026-04 payload contract.
// https://polar.sh/docs/api-reference/2026-04/versioning
export const DEFAULT_POLAR_API_VERSION = POLAR_API_VERSIONS[0];
export const polarApiVersionSchema = v.picklist(POLAR_API_VERSIONS);

export const POLAR_ENTITLEMENT_STATUSES = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const;
export const polarEntitlementStatusSchema = v.picklist(
  POLAR_ENTITLEMENT_STATUSES,
);
export type PolarEntitlementStatus = v.InferOutput<
  typeof polarEntitlementStatusSchema
>;
