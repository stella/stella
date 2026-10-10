import { Result } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import { sellerProfiles } from "@/api/db/schema";
import { sellerProfileParams } from "@/api/handlers/seller-profiles/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Archive an issuer profile so it is unavailable for new invoices. " +
    "The retained record remains available for historical references.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  params: sellerProfileParams,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session, recordAuditEvent }) {
    const archived = yield* Result.await(
      safeDb(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${session.activeOrganizationId}, 0))`,
        );
        const rows = await tx
          .update(sellerProfiles)
          .set({
            archivedAt: new Date(),
            isDefault: false,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(sellerProfiles.id, params.sellerProfileId),
              eq(sellerProfiles.organizationId, session.activeOrganizationId),
              isNull(sellerProfiles.archivedAt),
            ),
          )
          .returning({ id: sellerProfiles.id });
        const row = rows.at(0);
        if (row) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.SELLER_PROFILE,
            resourceId: row.id,
            workspaceId: null,
            metadata: { change: "archived" },
          });
        }
        return row ?? null;
      }),
    );
    if (!archived) {
      return Result.err(
        new HandlerError({ status: 404, message: "Seller profile not found" }),
      );
    }
    return Result.ok({ id: archived.id, archived: true });
  },
);
