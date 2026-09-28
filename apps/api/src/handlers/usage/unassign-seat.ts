import { Result } from "better-result";
import { and, count, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  organizationFileUsage,
  usageEntitlements,
  usagePolicies,
  usageSeatAssignments,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tUserId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { lockAssignmentCapacity } from "@/api/lib/usage/assignment-capacity";

/**
 * Release a member's per-user included limit. Idempotent: releasing
 * an unassigned member is a no-op success, so retries and races with
 * member removal stay quiet.
 */

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "internal", reason: "hosted_billing" },
  body: t.Object({
    userId: tUserId,
  }),
} satisfies HandlerConfig;

const unassignSeat = createSafeRootHandler(
  config,
  async function* ({ body, session, safeDb, recordAuditEvent }) {
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        // Serialize with designation so a racing capacity check cannot
        // count a row that this release is about to remove.
        await lockAssignmentCapacity(tx, session.activeOrganizationId);

        if (env.FEATURE_FILE_USAGE_LIMITS) {
          const assigned = await tx
            .select({ id: usageSeatAssignments.id })
            .from(usageSeatAssignments)
            .where(
              and(
                eq(
                  usageSeatAssignments.organizationId,
                  session.activeOrganizationId,
                ),
                eq(usageSeatAssignments.userId, body.userId),
              ),
            )
            .limit(1)
            .then((rows) => rows.at(0));
          if (assigned) {
            const roster = await tx
              .select({ value: count() })
              .from(usageSeatAssignments)
              .where(
                eq(
                  usageSeatAssignments.organizationId,
                  session.activeOrganizationId,
                ),
              )
              .then((rows) => rows.at(0)?.value ?? 0);
            const capability = await tx
              .select({ bytes: usagePolicies.storageBytesPerAssignment })
              .from(usageEntitlements)
              .innerJoin(
                usagePolicies,
                eq(usageEntitlements.usagePolicyId, usagePolicies.id),
              )
              .where(
                eq(
                  usageEntitlements.organizationId,
                  session.activeOrganizationId,
                ),
              )
              .limit(1)
              .then((rows) => rows.at(0));
            const usage = await tx
              .select({
                committedBytes: organizationFileUsage.committedBytes,
                reservedBytes: organizationFileUsage.reservedBytes,
              })
              .from(organizationFileUsage)
              .where(
                eq(
                  organizationFileUsage.organizationId,
                  session.activeOrganizationId,
                ),
              )
              .limit(1)
              .then((rows) => rows.at(0));
            if (
              capability?.bytes !== null &&
              capability?.bytes !== undefined &&
              usage &&
              usage.committedBytes + usage.reservedBytes >
                capability.bytes * BigInt(roster - 1)
            ) {
              return "capacity_exceeded" as const;
            }
          }
        }

        const deleted = await tx
          .delete(usageSeatAssignments)
          .where(
            and(
              eq(
                usageSeatAssignments.organizationId,
                session.activeOrganizationId,
              ),
              eq(usageSeatAssignments.userId, body.userId),
            ),
          )
          .returning({ id: usageSeatAssignments.id });
        if (deleted.at(0) === undefined) {
          return "unassigned" as const;
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          metadata: {
            field: "usageAssignment",
            userId: body.userId,
          },
        });
        return "released" as const;
      }),
    );
    if (outcome === "capacity_exceeded") {
      return Result.err(
        new HandlerError({
          status: 409,
          message:
            "Organization file usage exceeds the remaining assignment capacity",
        }),
      );
    }
    return Result.ok({ assigned: false });
  },
);

export default unassignSeat;
