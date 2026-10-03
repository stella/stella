/**
 * Budget lane decision for a metered chat turn.
 *
 * The decision reads the org's entitlement budgets and the user's lane
 * counters, both as point lookups; consumption crossing a budget
 * mid-turn is allowed (the turn that crosses completes) and the next
 * decision lands on the other side of it.
 */

import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  usageEntitlements,
  usagePolicies,
  usageSeatAssignments,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { getLaneCounterMicroUnits } from "@/api/lib/usage/lane-budget";
import { memberMayUseAI } from "@/api/lib/usage/member-capacity";
import {
  isEntitlementConsumableAt,
  resolveUsageConsumption,
} from "@/api/lib/usage/usage-ledger";

export type UsageLaneDecision =
  | { lane: "allowance" }
  | { lane: "fallback"; forcedModelSelection: string }
  | { lane: "pool" };

/**
 * Budget verdict only: which lane the user's budgets admit, or
 * `unassigned` when the organization admits only members holding a seat
 * assignment to AI work and this user holds none. Whether a fallback
 * verdict is actually servable (a fallback model exists on this
 * deployment) is the pre-flight's composition concern.
 */
export type LaneBudgetVerdict = UsageLaneDecision["lane"] | "unassigned";

type DecideChatUsageLaneInput = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  asOf?: Date;
};

/**
 * Decide which budget a chat turn draws from. `pool` reproduces the
 * pre-lane behavior exactly and is the answer whenever the org's
 * policy declares no budgets, so deployments that never seed them are
 * untouched. A member the organization does not admit to AI work (see
 * `memberMayUseAI`) never falls back to the pool.
 */
export const decideChatUsageLane = async ({
  tx,
  organizationId,
  userId,
  asOf = new Date(),
}: DecideChatUsageLaneInput): Promise<LaneBudgetVerdict> => {
  if (!(await memberMayUseAI(tx, organizationId, userId))) {
    return "unassigned";
  }

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
    entitlement.dailyAllowanceMicroUnits === null ||
    !(await resolveUsageConsumption({
      tx,
      organizationId,
      originalAccess: isEntitlementConsumableAt(entitlement, asOf),
      currentPeriodStart: entitlement.currentPeriodStart,
      asOf,
    }))
  ) {
    return "pool";
  }

  // Per-user budgets belong to assigned members only. Where assignment
  // is not required for AI access, everyone else keeps the shared-pool
  // path (the pool check still runs downstream exactly as before
  // budgets existed).
  const assignment = await tx
    .select({ id: usageSeatAssignments.id })
    .from(usageSeatAssignments)
    .where(
      and(
        eq(usageSeatAssignments.organizationId, organizationId),
        eq(usageSeatAssignments.userId, userId),
      ),
    )
    .limit(1);
  if (assignment.at(0) === undefined) {
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
