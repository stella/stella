import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { usageSeatAssignments } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tUserId } from "@/api/lib/custom-schema";

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
    yield* Result.await(
      safeDb(async (tx) => {
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
          return;
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
      }),
    );
    return Result.ok({ assigned: false });
  },
);

export default unassignSeat;
