import { Result } from "better-result";
import { and, count, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { member } from "@/api/db/auth-schema";
import { usageEntitlements, usageSeatAssignments } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tUserId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/**
 * Assign a member to one of the organisation's per-user included
 * limits. The count is bounded by the entitlement's capacity inside
 * the same transaction, so concurrent assigns cannot exceed it past
 * the last free slot.
 */

/**
 * Namespace for the per-organization assignment-capacity lock.
 * `pg_advisory_xact_lock` keys collide across unrelated advisory
 * locks; the org-id hash is the second key. Row locks are not an
 * option here: RLS restrictive `no_update` policies on
 * `usage_entitlements` and `usage_seat_assignments` filter rows out
 * of `SELECT ... FOR UPDATE` for the app role.
 */
const SEAT_CAPACITY_LOCK_NAMESPACE = 0x5e_a7_ca_9a;

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "internal", reason: "hosted_billing" },
  body: t.Object({
    userId: tUserId,
  }),
} satisfies HandlerConfig;

const assignSeat = createSafeRootHandler(
  config,
  async function* ({ body, session, safeDb, user, recordAuditEvent }) {
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const memberRows = await tx
          .select({ userId: member.userId })
          .from(member)
          .where(
            and(
              eq(member.organizationId, session.activeOrganizationId),
              eq(member.userId, body.userId),
            ),
          )
          .limit(1);
        if (memberRows.at(0) === undefined) {
          return { kind: "not_a_member" as const };
        }

        // Serialize concurrent assigns per organization so two
        // requests cannot both observe the last free slot.
        await tx.execute(
          sql`select pg_advisory_xact_lock(${SEAT_CAPACITY_LOCK_NAMESPACE}, hashtext(${session.activeOrganizationId}))`,
        );

        const entitlementRows = await tx
          .select({ seats: usageEntitlements.seats })
          .from(usageEntitlements)
          .where(
            eq(usageEntitlements.organizationId, session.activeOrganizationId),
          )
          .limit(1);
        const entitlement = entitlementRows.at(0);
        if (!entitlement) {
          return { kind: "no_entitlement" as const };
        }

        // Idempotent re-assign must succeed even when the plan is full,
        // so check for an existing row before enforcing capacity.
        const existingRows = await tx
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
          .limit(1);
        if (existingRows.at(0)) {
          return { kind: "already_assigned" as const };
        }

        const assignedRows = await tx
          .select({ value: count() })
          .from(usageSeatAssignments)
          .where(
            eq(
              usageSeatAssignments.organizationId,
              session.activeOrganizationId,
            ),
          );
        const assigned = assignedRows.at(0)?.value ?? 0;
        if (assigned >= entitlement.seats) {
          return { kind: "capacity_reached" as const };
        }

        const inserted = await tx
          .insert(usageSeatAssignments)
          .values({
            organizationId: session.activeOrganizationId,
            userId: body.userId,
            assignedByUserId: user.id,
          })
          .onConflictDoNothing({
            target: [
              usageSeatAssignments.organizationId,
              usageSeatAssignments.userId,
            ],
          })
          .returning({ id: usageSeatAssignments.id });
        if (inserted.at(0) === undefined) {
          return { kind: "already_assigned" as const };
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          metadata: {
            field: "usageAssignment",
            userId: body.userId,
          },
        });
        return { kind: "assigned" as const };
      }),
    );

    switch (outcome.kind) {
      case "not_a_member":
        return Result.err(
          new HandlerError({
            status: 404,
            message: "User is not a member of this organization",
          }),
        );
      case "no_entitlement":
        return Result.err(
          new HandlerError({
            status: 409,
            message: "No active plan to assign against",
          }),
        );
      case "capacity_reached":
        return Result.err(
          new HandlerError({
            status: 409,
            message: "All included per-user limits are assigned",
          }),
        );
      case "assigned":
      case "already_assigned":
        return Result.ok({ assigned: true });
      default:
        outcome satisfies never;
        return Result.ok({ assigned: true });
    }
  },
);

export default assignSeat;
