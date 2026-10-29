import { panic, Result } from "better-result";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { VAT_RATE_PRESETS } from "@stll/invoicing";

import { vatRates } from "@/api/db/schema";
import { applyVatRatePresetBody } from "@/api/handlers/vat-rates/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  lockVatRateOrganization,
  overlappingVatRatePeriods,
} from "@/api/lib/billing/vat-rates";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { organizationResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const config = {
  contract: "patch",
  realtime: organizationResourceSetUpdates(RESOURCE_TYPE.VAT_RATE),
  description:
    "Add the statutory VAT rate preset for Slovakia or Czechia to the active organization. Existing overlapping periods with the same code are skipped.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  body: applyVatRatePresetBody,
} satisfies HandlerConfig;

const applyVatRatePreset = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        await lockVatRateOrganization(tx, session.activeOrganizationId);
        const presets = VAT_RATE_PRESETS[body.country];
        const overlapping = await overlappingVatRatePeriods(tx, {
          organizationId: session.activeOrganizationId,
          periods: presets,
        });
        const additions = presets.filter(
          (_preset, position) => !overlapping.has(position),
        );
        const skipped = presets.length - additions.length;
        if (additions.length === 0) {
          return { added: 0, skipped };
        }
        // A country's preset periods never overlap each other (the preset
        // census in @stll/invoicing), so they are inserted together.
        const inserted = await tx
          .insert(vatRates)
          .values(
            additions.map((preset) => ({
              ...preset,
              organizationId: session.activeOrganizationId,
            })),
          )
          .returning({ id: vatRates.id, code: vatRates.code });
        if (inserted.length !== additions.length) {
          panic("Failed to add VAT preset rate");
        }
        await recordAuditEvent(
          tx,
          inserted.map((row) => ({
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.VAT_RATE,
            resourceId: row.id,
            workspaceId: null,
            metadata: { code: row.code, presetCountry: body.country },
          })),
        );
        return { added: inserted.length, skipped };
      }),
    );
    return Result.ok(result);
  },
);

declareAggregateMutation(applyVatRatePreset, {
  type: "independent",
  reason:
    "Adds one organization's statutory VAT rate periods under that organization's VAT rate advisory lock; no aggregate state spans organizations.",
});

export default applyVatRatePreset;
