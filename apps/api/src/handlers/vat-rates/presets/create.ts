import { panic, Result } from "better-result";

import { VAT_RATE_PRESETS } from "@stll/invoicing";

import { vatRates } from "@/api/db/schema";
import { applyVatRatePresetBody } from "@/api/handlers/vat-rates/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  checkVatRateOverlap,
  lockVatRateOrganization,
} from "@/api/lib/billing/vat-rates";

const config = {
  contract: "patch",
  description:
    "Add the statutory VAT rate preset for Slovakia or Czechia to the active organization. Existing overlapping periods with the same code are skipped.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  body: applyVatRatePresetBody,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        await lockVatRateOrganization(tx, session.activeOrganizationId);
        let added = 0;
        let skipped = 0;
        for (const preset of VAT_RATE_PRESETS[body.country]) {
          const overlap = await checkVatRateOverlap(tx, {
            organizationId: session.activeOrganizationId,
            code: preset.code,
            startDate: preset.validFrom,
            endDate: preset.validTo,
          });
          if (Result.isError(overlap)) {
            skipped += 1;
            continue;
          }
          const inserted = await tx
            .insert(vatRates)
            .values({
              ...preset,
              organizationId: session.activeOrganizationId,
            })
            .returning({ id: vatRates.id });
          const row = inserted.at(0);
          if (!row) {
            panic("Failed to add VAT preset rate");
          }
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.VAT_RATE,
            resourceId: row.id,
            workspaceId: null,
            metadata: { code: preset.code, presetCountry: body.country },
          });
          added += 1;
        }
        return { added, skipped };
      }),
    );
    return Result.ok(result);
  },
);
