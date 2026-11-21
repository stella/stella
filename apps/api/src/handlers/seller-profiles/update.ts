import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import { normalizeIban } from "@stll/invoicing";

import { sellerProfiles } from "@/api/db/schema";
import {
  SELLER_PROFILE_EDITABLE_FIELDS,
  sellerProfileParams,
  updateSellerProfileBody,
  VAT_PAYER_REQUIRES_VAT_ID,
  vatPayerWithoutVatId,
} from "@/api/handlers/seller-profiles/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { pickDefined } from "@/api/lib/pick-defined";

const config = {
  contract: "patch",
  description:
    "Update an active issuer profile in the active organization. Omitted " +
    "fields stay unchanged; null clears an optional field. A VAT payer " +
    "(vatPayer: true) must keep a VAT ID.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  params: sellerProfileParams,
  body: updateSellerProfileBody,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ body, params, safeDb, session, recordAuditEvent }) {
    const updates = pickDefined(body, SELLER_PROFILE_EDITABLE_FIELDS);
    if (body.iban !== undefined && body.iban !== null) {
      const normalized = normalizeIban(body.iban);
      if (normalized === null) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid IBAN" }),
        );
      }
      updates.iban = normalized;
    }
    if (updates.bic !== undefined && updates.bic !== null) {
      updates.bic = updates.bic.toUpperCase();
    }

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .select({
            id: sellerProfiles.id,
            vatId: sellerProfiles.vatId,
            vatPayer: sellerProfiles.vatPayer,
          })
          .from(sellerProfiles)
          .where(
            and(
              eq(sellerProfiles.id, params.sellerProfileId),
              eq(sellerProfiles.organizationId, session.activeOrganizationId),
              isNull(sellerProfiles.archivedAt),
            ),
          )
          .limit(1)
          .for("update");
        const existing = rows.at(0);
        if (!existing) {
          return null;
        }
        if (
          vatPayerWithoutVatId(
            updates.vatPayer ?? existing.vatPayer,
            updates.vatId === undefined ? existing.vatId : updates.vatId,
          )
        ) {
          return "vat-payer-without-vat-id" as const;
        }
        const changedFields = Object.keys(updates);
        if (changedFields.length === 0) {
          return { id: existing.id };
        }
        const updatedRows = await tx
          .update(sellerProfiles)
          .set({ ...updates, updatedAt: new Date() })
          .where(
            and(
              eq(sellerProfiles.id, existing.id),
              eq(sellerProfiles.organizationId, session.activeOrganizationId),
              isNull(sellerProfiles.archivedAt),
            ),
          )
          .returning({ id: sellerProfiles.id });
        const updated = updatedRows.at(0);
        if (updated) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.SELLER_PROFILE,
            resourceId: updated.id,
            workspaceId: null,
            metadata: { changedFields },
          });
        }
        return updated ?? null;
      }),
    );
    if (result === "vat-payer-without-vat-id") {
      return Result.err(new HandlerError(VAT_PAYER_REQUIRES_VAT_ID));
    }
    if (!result) {
      return Result.err(
        new HandlerError({ status: 404, message: "Seller profile not found" }),
      );
    }
    return Result.ok(result);
  },
);
