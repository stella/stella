/**
 * The contract of the `organization_effective_policy` database function
 * (migration 20261005090300), which every member and storage limit reads.
 *
 * How long an entitlement in each status binds its policy's limits: `paid`
 * until the provider changes the status (`past_due` and `paused` keep paid
 * limits until the provider cancels), `until_period_end` while a cancelled
 * entitlement's `current_period_end` is in the future. A status absent from
 * the map fails typecheck; `organization-effective-policy.postgres.test.ts`
 * walks every entry against the database function, so the SQL status lists
 * cannot drift from this map unnoticed.
 */

import type { UsageEntitlementStatus } from "@/api/db/schema";

export const ENTITLEMENT_LIMIT_DISPOSITION = {
  paid: "paid",
  untilPeriodEnd: "until_period_end",
} as const;

export type EntitlementLimitDisposition =
  (typeof ENTITLEMENT_LIMIT_DISPOSITION)[keyof typeof ENTITLEMENT_LIMIT_DISPOSITION];

export const ENTITLEMENT_LIMIT_DISPOSITION_BY_STATUS = {
  trialing: ENTITLEMENT_LIMIT_DISPOSITION.paid,
  active: ENTITLEMENT_LIMIT_DISPOSITION.paid,
  past_due: ENTITLEMENT_LIMIT_DISPOSITION.paid,
  paused: ENTITLEMENT_LIMIT_DISPOSITION.paid,
  cancelled: ENTITLEMENT_LIMIT_DISPOSITION.untilPeriodEnd,
} as const satisfies Record<
  UsageEntitlementStatus,
  EntitlementLimitDisposition
>;
