import { Result } from "better-result";
import { eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { usageEntitlements, usagePolicies } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { getRemainingUsageUnits } from "@/api/lib/usage/usage-ledger";

/** Read the caller organisation's usage entitlement and current state. */

const config = {
  // Entitlement state (plan, seats, period, remaining units) is
  // organization billing data, so it is gated to managers — matching the
  // hosted setup/management endpoints and the other organization-settings
  // reads. Non-managers have no settings UI for it and cannot manage it.
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "tool", name: "get_usage" },
} satisfies HandlerConfig;

// Shared entitlement read reused by the HTTP handler and the `get_usage` MCP
// tool, so both return the same plan/seat/period/remaining-units shape.
export const readOrgEntitlementHandler = async function* ({
  safeDb,
  organizationId,
}: {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
}) {
  const result = yield* Result.await(
    safeDb(async (tx) => {
      const rows = await tx
        .select({
          id: usageEntitlements.id,
          status: usageEntitlements.status,
          seats: usageEntitlements.seats,
          source: usageEntitlements.source,
          currentPeriodStart: usageEntitlements.currentPeriodStart,
          currentPeriodEnd: usageEntitlements.currentPeriodEnd,
          cancelAtPeriodEnd: usageEntitlements.cancelAtPeriodEnd,
          policyId: usagePolicies.id,
          policyKey: usagePolicies.policyKey,
          policyDisplayName: usagePolicies.displayName,
          policyMonthlyUsageUnits: usagePolicies.monthlyUsageUnits,
        })
        .from(usageEntitlements)
        .innerJoin(
          usagePolicies,
          eq(usagePolicies.id, usageEntitlements.usagePolicyId),
        )
        .where(eq(usageEntitlements.organizationId, organizationId))
        .limit(1);

      const entitlement = rows.at(0);
      if (!entitlement) {
        return { entitlement: null } as const;
      }

      const remainingUsageUnits = await getRemainingUsageUnits({
        tx,
        organizationId,
      });

      return {
        entitlement: {
          id: entitlement.id,
          status: entitlement.status,
          seats: entitlement.seats,
          source: entitlement.source,
          currentPeriodStart: entitlement.currentPeriodStart.toISOString(),
          currentPeriodEnd: entitlement.currentPeriodEnd.toISOString(),
          cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd,
        },
        policy: {
          id: entitlement.policyId,
          key: entitlement.policyKey,
          displayName: entitlement.policyDisplayName,
          monthlyUsageUnitsPerSeat: entitlement.policyMonthlyUsageUnits,
        },
        remainingUsageUnits,
      };
    }),
  );

  return Result.ok(result);
};

const getEntitlement = createSafeRootHandler(
  config,
  async function* ({ session, safeDb }) {
    return yield* readOrgEntitlementHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
    });
  },
);

export default getEntitlement;
