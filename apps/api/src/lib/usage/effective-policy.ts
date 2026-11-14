/**
 * The contract of the `organization_effective_policy` database function
 * (migrations 20261005090300 and 20261025120000), which every member and
 * storage limit reads.
 *
 * How long an entitlement binds its policy's limits: `paid` until the
 * provider changes the status (`past_due` and `paused` keep paid limits until
 * the provider cancels), `until_period_end` while its `current_period_end` is
 * in the future. A hosted entitlement follows its status; a manual one has no
 * provider to change it, so its period end alone bounds it. A source or
 * status absent from the maps fails typecheck;
 * `organization-effective-policy.postgres.test.ts` walks every source and
 * status against the database function, so the SQL lists cannot drift from
 * this contract unnoticed.
 */

import { panic } from "better-result";

import type {
  UsageEntitlementSource,
  UsageEntitlementStatus,
} from "@/api/db/schema";

export const ENTITLEMENT_LIMIT_DISPOSITION = {
  paid: "paid",
  untilPeriodEnd: "until_period_end",
} as const;

export type EntitlementLimitDisposition =
  (typeof ENTITLEMENT_LIMIT_DISPOSITION)[keyof typeof ENTITLEMENT_LIMIT_DISPOSITION];

const ENTITLEMENT_LIMIT_DISPOSITION_BY_STATUS = {
  trialing: ENTITLEMENT_LIMIT_DISPOSITION.paid,
  active: ENTITLEMENT_LIMIT_DISPOSITION.paid,
  past_due: ENTITLEMENT_LIMIT_DISPOSITION.paid,
  paused: ENTITLEMENT_LIMIT_DISPOSITION.paid,
  cancelled: ENTITLEMENT_LIMIT_DISPOSITION.untilPeriodEnd,
} as const satisfies Record<
  UsageEntitlementStatus,
  EntitlementLimitDisposition
>;

export const entitlementLimitDisposition = ({
  source,
  status,
}: {
  source: UsageEntitlementSource;
  status: UsageEntitlementStatus;
}): EntitlementLimitDisposition => {
  switch (source) {
    case "hosted":
      return ENTITLEMENT_LIMIT_DISPOSITION_BY_STATUS[status];
    case "manual":
      return ENTITLEMENT_LIMIT_DISPOSITION.untilPeriodEnd;
    default:
      source satisfies never;
      return panic(`Unhandled entitlement source: ${String(source)}`);
  }
};
