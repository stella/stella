import { panic, Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import { vatRates } from "@/api/db/schema";
import {
  updateVatRateBody,
  vatRateParams,
} from "@/api/handlers/vat-rates/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  checkVatRateOverlap,
  lockVatRateOrganization,
} from "@/api/lib/billing/vat-rates";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { pickDefined } from "@/api/lib/pick-defined";

const config = {
  description:
    "Update an active VAT rate validity period without overlapping another period for its code.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  params: vatRateParams,
  body: updateVatRateBody,
} satisfies HandlerConfig;
export default createSafeRootHandler(
  config,
  async function* ({ body, params, safeDb, session, recordAuditEvent }) {
    const updates = pickDefined(body, [
      "code",
      "name",
      "rateBps",
      "validFrom",
      "validTo",
    ]);
    const result = yield* Result.await(
      safeDb(async (tx) => {
        await lockVatRateOrganization(tx, session.activeOrganizationId);
        const rows = await tx
          .select()
          .from(vatRates)
          .where(
            and(
              eq(vatRates.id, params.vatRateId),
              eq(vatRates.organizationId, session.activeOrganizationId),
              isNull(vatRates.archivedAt),
            ),
          )
          .limit(1);
        const current = rows.at(0);
        if (!current) {
          return Result.err(
            new HandlerError({ status: 404, message: "VAT rate not found" }),
          );
        }
        const validFrom = body.validFrom ?? current.validFrom;
        const validTo =
          body.validTo === undefined ? current.validTo : body.validTo;
        const overlap = await checkVatRateOverlap(tx, {
          organizationId: session.activeOrganizationId,
          code: body.code ?? current.code,
          startDate: validFrom,
          endDate: validTo,
          excludeId: current.id,
        });
        if (Result.isError(overlap)) {
          return overlap;
        }
        const changedFields = Object.keys(updates);
        if (changedFields.length === 0) {
          return Result.ok({ id: current.id });
        }
        const updated = await tx
          .update(vatRates)
          .set({ ...updates, updatedAt: new Date() })
          .where(
            and(
              eq(vatRates.id, current.id),
              eq(vatRates.organizationId, session.activeOrganizationId),
              isNull(vatRates.archivedAt),
            ),
          )
          .returning({ id: vatRates.id });
        const row = updated.at(0) ?? panic("Locked VAT rate disappeared");
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.VAT_RATE,
          resourceId: row.id,
          workspaceId: null,
          metadata: { changedFields },
        });
        return Result.ok(row);
      }),
    );
    return result;
  },
);
