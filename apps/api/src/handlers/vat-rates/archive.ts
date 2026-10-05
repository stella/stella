import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import { vatRates } from "@/api/db/schema";
import { vatRateParams } from "@/api/handlers/vat-rates/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { lockVatRateOrganization } from "@/api/lib/billing/vat-rates";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description: "Archive a VAT rate period in the active organization.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  params: vatRateParams,
} satisfies HandlerConfig;
export default createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session, recordAuditEvent }) {
    const archived = yield* Result.await(
      safeDb(async (tx) => {
        await lockVatRateOrganization(tx, session.activeOrganizationId);
        const rows = await tx
          .update(vatRates)
          .set({ archivedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(vatRates.id, params.vatRateId),
              eq(vatRates.organizationId, session.activeOrganizationId),
              isNull(vatRates.archivedAt),
            ),
          )
          .returning({ id: vatRates.id });
        const row = rows.at(0);
        if (!row) {
          return null;
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.VAT_RATE,
          resourceId: row.id,
          workspaceId: null,
          metadata: { change: "archived" },
        });
        return row;
      }),
    );
    if (!archived) {
      return Result.err(
        new HandlerError({ status: 404, message: "VAT rate not found" }),
      );
    }
    return Result.ok({ id: archived.id, archived: true });
  },
);
