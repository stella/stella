import { panic, Result } from "better-result";

import { vatRates } from "@/api/db/schema";
import { createVatRateBody } from "@/api/handlers/vat-rates/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  checkVatRateOverlap,
  lockVatRateOrganization,
} from "@/api/lib/billing/vat-rates";

const config = {
  description:
    "Create a VAT rate validity period in the active organization. validFrom is inclusive; validTo is exclusive.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  body: createVatRateBody,
} satisfies HandlerConfig;
export default createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        await lockVatRateOrganization(tx, session.activeOrganizationId);
        const overlap = await checkVatRateOverlap(tx, {
          organizationId: session.activeOrganizationId,
          code: body.code,
          startDate: body.validFrom,
          endDate: body.validTo ?? null,
        });
        if (Result.isError(overlap)) {
          return overlap;
        }
        const rows = await tx
          .insert(vatRates)
          .values({
            ...body,
            validTo: body.validTo ?? null,
            organizationId: session.activeOrganizationId,
          })
          .returning({ id: vatRates.id });
        const row = rows.at(0) ?? panic("Failed to create VAT rate");
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.VAT_RATE,
          resourceId: row.id,
          workspaceId: null,
          metadata: { code: body.code },
        });
        return Result.ok(row);
      }),
    );
    return result;
  },
);
