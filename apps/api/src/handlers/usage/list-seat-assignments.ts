import { Result } from "better-result";
import { asc, eq } from "drizzle-orm";

import { usageEntitlements, usageSeatAssignments } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";

/**
 * List which members currently draw the per-user included budgets,
 * alongside the entitlement's capacity. Bounded by the seat count, so
 * a plain list (no cursor envelope) matches the catalog precedent.
 */

const config = {
  description:
    "List the members assigned to the organization's per-user included " +
    "limits, with the total capacity. Requires organization-settings " +
    "management access.",
  permissions: { organizationSettings: ["update"] },
  access: "read",
  mcp: { type: "internal", reason: "hosted_billing" },
} satisfies HandlerConfig;

const listSeatAssignments = createSafeRootHandler(
  config,
  async function* ({ session, safeDb }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const entitlementRows = await tx
          .select({ seats: usageEntitlements.seats })
          .from(usageEntitlements)
          .where(
            eq(usageEntitlements.organizationId, session.activeOrganizationId),
          )
          .limit(1);
        const assignments = await tx
          .select({
            id: usageSeatAssignments.id,
            userId: usageSeatAssignments.userId,
            createdAt: usageSeatAssignments.createdAt,
          })
          .from(usageSeatAssignments)
          .where(
            eq(
              usageSeatAssignments.organizationId,
              session.activeOrganizationId,
            ),
          )
          .orderBy(asc(usageSeatAssignments.createdAt))
          .limit(LIMITS.usageAssignmentsMax);
        return {
          seats: entitlementRows.at(0)?.seats ?? null,
          assignments: assignments.map((assignment) => ({
            id: assignment.id,
            userId: assignment.userId,
            createdAt: assignment.createdAt.toISOString(),
          })),
        };
      }),
    );
    return Result.ok(result);
  },
);

export default listSeatAssignments;
