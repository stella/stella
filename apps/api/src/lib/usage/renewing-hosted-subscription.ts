import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { USAGE_ENTITLEMENT_STATUSES, usageEntitlements } from "@/api/db/schema";
import type { UsageEntitlementStatus } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export const ORGANIZATION_DELETION_REFUSAL_CODE = {
  subscriptionRenews: "organization_subscription_renews",
} as const;

// Which hosted statuses refuse an organization deletion: those the provider
// bills at the next renewal. Trials do not run in the provider (the
// evaluation period is Stella's own), and paused or cancelled subscriptions
// do not renew.
const DELETION_DISPOSITION_BY_STATUS = {
  trialing: "allows",
  active: "refuses",
  past_due: "refuses",
  cancelled: "allows",
  paused: "allows",
} as const satisfies Record<UsageEntitlementStatus, "refuses" | "allows">;

const RENEWING_STATUSES = USAGE_ENTITLEMENT_STATUSES.filter(
  (status) => DELETION_DISPOSITION_BY_STATUS[status] === "refuses",
);

/**
 * Whether the organization holds a hosted subscription the provider will
 * renew. Locks the entitlement row, so a webhook that changes it waits for
 * the caller's transaction instead of interleaving with it.
 */
export const hasRenewingHostedSubscription = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<boolean> => {
  const rows = await tx
    .select({ id: usageEntitlements.id })
    .from(usageEntitlements)
    .where(
      and(
        eq(usageEntitlements.organizationId, organizationId),
        eq(usageEntitlements.source, "hosted"),
        inArray(usageEntitlements.status, RENEWING_STATUSES),
        eq(usageEntitlements.cancelAtPeriodEnd, false),
      ),
    )
    .limit(1)
    .for("update");
  return rows.length > 0;
};
