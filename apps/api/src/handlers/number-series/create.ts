import { panic, Result } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import { numberSeries } from "@/api/db/schema";
import { createNumberSeriesBody } from "@/api/handlers/number-series/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  MAX_NUMBER_SERIES_SEQUENCE_DIGITS,
  validateNumberPattern,
} from "@/api/lib/billing/number-pattern";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description: "Create a document number series in the active organization.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  body: createNumberSeriesBody,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, recordAuditEvent }) {
    const valid = validateNumberPattern({
      pattern: body.pattern,
      padding: body.padding,
      sequenceDigitsBudget: MAX_NUMBER_SERIES_SEQUENCE_DIGITS,
    });
    if (Result.isError(valid)) {
      return Result.err(
        new HandlerError({ status: 400, message: valid.error.message }),
      );
    }
    const created = yield* Result.await(
      safeDb(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${session.activeOrganizationId}:number-series:${body.documentType}`}, 0))`,
        );
        if (body.sellerProfileId) {
          const profile = await tx.query.sellerProfiles.findFirst({
            columns: { id: true },
            where: {
              id: { eq: body.sellerProfileId },
              organizationId: { eq: session.activeOrganizationId },
              archivedAt: { isNull: true },
            },
          });
          if (!profile) {
            return { status: "profile_not_found" } as const;
          }
        }
        const existing = await tx
          .select({ id: numberSeries.id })
          .from(numberSeries)
          .where(
            and(
              eq(numberSeries.organizationId, session.activeOrganizationId),
              eq(numberSeries.documentType, body.documentType),
              body.sellerProfileId
                ? eq(numberSeries.sellerProfileId, body.sellerProfileId)
                : isNull(numberSeries.sellerProfileId),
              eq(numberSeries.isDefault, true),
              isNull(numberSeries.archivedAt),
            ),
          )
          .limit(1);
        const rows = await tx
          .insert(numberSeries)
          .values({
            organizationId: session.activeOrganizationId,
            documentType: body.documentType,
            name: body.name,
            pattern: body.pattern,
            padding: body.padding,
            sellerProfileId: body.sellerProfileId ?? null,
            isDefault: existing.length === 0,
          })
          .returning({
            id: numberSeries.id,
            isDefault: numberSeries.isDefault,
          });
        const row = rows.at(0) ?? panic("Failed to create number series");
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.NUMBER_SERIES,
          resourceId: row.id,
          workspaceId: null,
          metadata: {
            documentType: body.documentType,
            isDefault: row.isDefault,
          },
        });
        return { status: "created", row } as const;
      }),
    );
    if (created.status === "profile_not_found") {
      return Result.err(
        new HandlerError({ status: 404, message: "Seller profile not found" }),
      );
    }
    return Result.ok(created.row);
  },
);
