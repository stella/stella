import { panic, Result } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import { sellerProfiles } from "@/api/db/schema";
import { sellerProfileParams } from "@/api/handlers/seller-profiles/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Make one active issuer profile the organization's default. An archived " +
    "profile cannot be selected.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  params: sellerProfileParams,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${session.activeOrganizationId}, 0))`,
        );
        const target = await tx.query.sellerProfiles.findFirst({
          where: {
            id: { eq: params.sellerProfileId },
            organizationId: { eq: session.activeOrganizationId },
            archivedAt: { isNull: true },
          },
          columns: { id: true, isDefault: true },
        });
        if (!target) {
          return null;
        }
        if (target.isDefault) {
          return target;
        }
        const currentRows = await tx
          .update(sellerProfiles)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(
            and(
              eq(sellerProfiles.organizationId, session.activeOrganizationId),
              eq(sellerProfiles.isDefault, true),
              isNull(sellerProfiles.archivedAt),
            ),
          )
          .returning({ id: sellerProfiles.id });
        const updatedRows = await tx
          .update(sellerProfiles)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(
            and(
              eq(sellerProfiles.id, target.id),
              eq(sellerProfiles.organizationId, session.activeOrganizationId),
              isNull(sellerProfiles.archivedAt),
            ),
          )
          .returning({ id: sellerProfiles.id });
        const updated =
          updatedRows.at(0) ?? panic("Failed to set default seller profile");
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.SELLER_PROFILE,
          resourceId: updated.id,
          workspaceId: null,
          metadata: {
            change: "set_default",
            previousDefaultId: currentRows.at(0)?.id ?? null,
          },
        });
        return updated;
      }),
    );
    if (!result) {
      return Result.err(
        new HandlerError({ status: 404, message: "Seller profile not found" }),
      );
    }
    return Result.ok({ id: result.id, isDefault: true });
  },
);
