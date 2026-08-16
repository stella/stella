import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { usageEntitlements, usagePolicies } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { getLaneCounterMicroUnits } from "@/api/lib/usage/lane-budget";
import { isEntitlementConsumableAt } from "@/api/lib/usage/usage-ledger";

/**
 * Read the caller's own budget-lane state: which lane their next chat
 * turn draws from and how much of each per-user budget the current
 * bucket has consumed. Self-scoped (any member reads their own state),
 * unlike the manager-gated entitlement read.
 */

const config = {
  description:
    "Read the calling user's current usage budget state: which budget " +
    "their next chat message draws from and how much of the included " +
    "budgets the current day/week has used. Returns { budgets: null } " +
    "when the organization's plan declares no per-user budgets.",
  permissions: { chat: ["create"] },
  access: "read",
  mcp: { type: "internal", reason: "chat_thread_ui" },
} satisfies HandlerConfig;

const getLane = createSafeRootHandler(
  config,
  async function* ({ session, safeDb, user }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
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
            eq(usagePolicies.id, usageEntitlements.usagePolicyId),
          )
          .where(
            eq(usageEntitlements.organizationId, session.activeOrganizationId),
          )
          .limit(1);
        const entitlement = rows.at(0);
        if (
          !entitlement ||
          !isEntitlementConsumableAt(entitlement) ||
          entitlement.dailyAllowanceMicroUnits === null
        ) {
          return { budgets: null } as const;
        }

        const dailyUsed = await getLaneCounterMicroUnits({
          tx,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          kind: "daily",
        });
        const weeklyUsed =
          entitlement.fallbackWeeklyMicroUnits === null
            ? null
            : await getLaneCounterMicroUnits({
                tx,
                organizationId: session.activeOrganizationId,
                userId: user.id,
                kind: "fallback_weekly",
              });

        return {
          budgets: {
            daily: {
              allowanceMicroUnits: entitlement.dailyAllowanceMicroUnits,
              usedMicroUnits: dailyUsed,
            },
            fallbackWeekly:
              entitlement.fallbackWeeklyMicroUnits === null ||
              weeklyUsed === null
                ? null
                : {
                    allowanceMicroUnits: entitlement.fallbackWeeklyMicroUnits,
                    usedMicroUnits: weeklyUsed,
                  },
          },
        };
      }),
    );
    return Result.ok(result);
  },
);

export default getLane;
