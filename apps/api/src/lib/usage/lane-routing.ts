/**
 * Budget lane decision for a metered chat turn.
 *
 * The decision reads the org's entitlement budgets and the user's lane
 * counters, both as point lookups; consumption crossing a budget
 * mid-turn is allowed (the turn that crosses completes) and the next
 * decision lands on the other side of it.
 */

import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { usageEntitlements, usagePolicies } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { getLaneCounterMicroUnits } from "@/api/lib/usage/lane-budget";
import { isEntitlementConsumableAt } from "@/api/lib/usage/usage-ledger";

export type UsageLaneDecision =
  | { lane: "allowance" }
  | { lane: "fallback"; forcedModelSelection: string }
  | { lane: "pool" };

/**
 * Budget verdict only: which lane the user's budgets admit. Whether a
 * fallback verdict is actually servable (a fallback model exists on
 * this deployment) is the pre-flight's composition concern.
 */
export type LaneBudgetVerdict = UsageLaneDecision["lane"];

type DecideChatUsageLaneInput = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: string;
  asOf?: Date;
};

/**
 * Decide which budget a chat turn draws from. `pool` reproduces the
 * pre-lane behavior exactly and is the answer whenever the org's
 * policy declares no budgets, so deployments that never seed them are
 * untouched.
 */
export const decideChatUsageLane = async ({
  tx,
  organizationId,
  userId,
  asOf = new Date(),
}: DecideChatUsageLaneInput): Promise<LaneBudgetVerdict> => {
  const rows = await tx
    .select({
      status: usageEntitlements.status,
      currentPeriodStart: usageEntitlements.currentPeriodStart,
      currentPeriodEnd: usageEntitlements.currentPeriodEnd,
      dailyAllowanceMicroUnits: usagePolicies.dailyAllowanceMicroUnits,
      fallbackWeeklyMicroUnits: usagePolicies.fallbackWeeklyMicroUnits,
    })
    .from(usageEntitlements)
    .innerJoin(
      usagePolicies,
      eq(usageEntitlements.usagePolicyId, usagePolicies.id),
    )
    .where(eq(usageEntitlements.organizationId, organizationId))
    .limit(1);
  const entitlement = rows.at(0);

  if (
    !entitlement ||
    !isEntitlementConsumableAt(entitlement, asOf) ||
    entitlement.dailyAllowanceMicroUnits === null
  ) {
    return "pool";
  }

  const dailyUsed = await getLaneCounterMicroUnits({
    tx,
    organizationId,
    userId,
    kind: "daily",
    asOf,
  });
  if (dailyUsed < entitlement.dailyAllowanceMicroUnits) {
    return "allowance";
  }

  if (entitlement.fallbackWeeklyMicroUnits === null) {
    return "pool";
  }
  const weeklyUsed = await getLaneCounterMicroUnits({
    tx,
    organizationId,
    userId,
    kind: "fallback_weekly",
    asOf,
  });
  if (weeklyUsed < entitlement.fallbackWeeklyMicroUnits) {
    return "fallback";
  }

  return "pool";
};
