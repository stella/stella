import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";

import { normalizeIban } from "@stll/invoicing";

import { sellerProfiles } from "@/api/db/schema";
import { createSellerProfileBody } from "@/api/handlers/seller-profiles/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Create an issuer profile for the active organization. The first active " +
    "profile becomes the default; later profiles can be made default explicitly.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  body: createSellerProfileBody,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, recordAuditEvent }) {
    const iban = body.iban === undefined ? null : normalizeIban(body.iban);
    if (body.iban !== undefined && iban === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid IBAN" }),
      );
    }

    const created = yield* Result.await(
      safeDb(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${session.activeOrganizationId}, 0))`,
        );
        const existingDefault = await tx.query.sellerProfiles.findFirst({
          where: {
            organizationId: { eq: session.activeOrganizationId },
            isDefault: { eq: true },
            archivedAt: { isNull: true },
          },
          columns: { id: true },
        });
        const rows = await tx
          .insert(sellerProfiles)
          .values({
            organizationId: session.activeOrganizationId,
            legalName: body.legalName,
            registrationId: body.registrationId ?? null,
            vatId: body.vatId ?? null,
            addressLine1: body.addressLine1 ?? null,
            addressLine2: body.addressLine2 ?? null,
            city: body.city ?? null,
            postalCode: body.postalCode ?? null,
            country: body.country ?? null,
            iban,
            bic: body.bic?.toUpperCase() ?? null,
            accountNumber: body.accountNumber ?? null,
            defaultCurrency: body.defaultCurrency,
            footerNotes: body.footerNotes ?? null,
            isDefault: existingDefault === undefined,
          })
          .returning({
            id: sellerProfiles.id,
            isDefault: sellerProfiles.isDefault,
          });
        const row = rows.at(0) ?? panic("Failed to create seller profile");
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.SELLER_PROFILE,
          resourceId: row.id,
          workspaceId: null,
          metadata: { isDefault: row.isDefault },
        });
        return row;
      }),
    );
    return Result.ok(created);
  },
);
