import { panic, Result } from "better-result";
import { and, eq, isNull, ne, sql } from "drizzle-orm";

import { numberSeries, numberSeriesCounters } from "@/api/db/schema";
import {
  numberSeriesParams,
  updateNumberSeriesBody,
} from "@/api/handlers/number-series/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  MAX_NUMBER_SERIES_SEQUENCE_DIGITS,
  validateNumberPattern,
} from "@/api/lib/billing/number-pattern";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { pickDefined } from "@/api/lib/pick-defined";

const EDITABLE_FIELDS = [
  "name",
  "pattern",
  "padding",
  "sellerProfileId",
] as const;

const config = {
  description:
    "Update an active number series. Pattern and padding lock after first allocation.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  params: numberSeriesParams,
  body: updateNumberSeriesBody,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ body, params, safeDb, session, recordAuditEvent }) {
    const updates = pickDefined(body, EDITABLE_FIELDS);
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const target = await tx.query.numberSeries.findFirst({
          columns: { documentType: true },
          where: {
            id: { eq: params.numberSeriesId },
            organizationId: { eq: session.activeOrganizationId },
            archivedAt: { isNull: true },
          },
        });
        if (!target) {
          return { status: "not_found" } as const;
        }
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${session.activeOrganizationId}:number-series:${target.documentType}`}, 0))`,
        );
        const rows = await tx
          .select({
            id: numberSeries.id,
            pattern: numberSeries.pattern,
            padding: numberSeries.padding,
            sellerProfileId: numberSeries.sellerProfileId,
            isDefault: numberSeries.isDefault,
          })
          .from(numberSeries)
          .where(
            and(
              eq(numberSeries.id, params.numberSeriesId),
              eq(numberSeries.organizationId, session.activeOrganizationId),
              isNull(numberSeries.archivedAt),
            ),
          )
          .for("update");
        const current = rows.at(0);
        if (!current) {
          return { status: "not_found" } as const;
        }
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
        if (
          current.isDefault &&
          body.sellerProfileId !== undefined &&
          body.sellerProfileId !== current.sellerProfileId
        ) {
          const conflicting = await tx
            .select({ id: numberSeries.id })
            .from(numberSeries)
            .where(
              and(
                eq(numberSeries.organizationId, session.activeOrganizationId),
                eq(numberSeries.documentType, target.documentType),
                eq(numberSeries.isDefault, true),
                isNull(numberSeries.archivedAt),
                ne(numberSeries.id, current.id),
                body.sellerProfileId === null
                  ? isNull(numberSeries.sellerProfileId)
                  : eq(numberSeries.sellerProfileId, body.sellerProfileId),
              ),
            )
            .limit(1);
          if (conflicting.length > 0) {
            return { status: "scope_conflict" } as const;
          }
        }
        const pattern = body.pattern ?? current.pattern;
        const padding = body.padding ?? current.padding;
        const validation = validateNumberPattern({
          pattern,
          padding,
          sequenceDigitsBudget: MAX_NUMBER_SERIES_SEQUENCE_DIGITS,
        });
        if (Result.isError(validation)) {
          return {
            status: "invalid",
            message: validation.error.message,
          } as const;
        }
        if (pattern !== current.pattern || padding !== current.padding) {
          const used = await tx
            .select({ seriesId: numberSeriesCounters.seriesId })
            .from(numberSeriesCounters)
            .where(
              and(
                eq(numberSeriesCounters.seriesId, current.id),
                eq(
                  numberSeriesCounters.organizationId,
                  session.activeOrganizationId,
                ),
              ),
            )
            .limit(1);
          if (used.length > 0) {
            return { status: "allocated" } as const;
          }
        }
        const changedFields = Object.keys(updates);
        if (changedFields.length === 0) {
          return { status: "updated", id: current.id } as const;
        }
        const updated = await tx
          .update(numberSeries)
          .set({ ...updates, updatedAt: new Date() })
          .where(
            and(
              eq(numberSeries.id, current.id),
              eq(numberSeries.organizationId, session.activeOrganizationId),
            ),
          )
          .returning({ id: numberSeries.id });
        const row = updated.at(0);
        if (!row) {
          return { status: "not_found" } as const;
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.NUMBER_SERIES,
          resourceId: row.id,
          workspaceId: null,
          metadata: { changedFields },
        });
        return { status: "updated", id: row.id } as const;
      }),
    );
    switch (result.status) {
      case "updated":
        return Result.ok({ id: result.id });
      case "not_found":
        return Result.err(
          new HandlerError({ status: 404, message: "Number series not found" }),
        );
      case "profile_not_found":
        return Result.err(
          new HandlerError({
            status: 404,
            message: "Seller profile not found",
          }),
        );
      case "invalid":
        return Result.err(
          new HandlerError({ status: 400, message: result.message }),
        );
      case "scope_conflict":
        return Result.err(
          new HandlerError({
            status: 409,
            message:
              "A default number series already exists for this seller scope",
          }),
        );
      case "allocated":
        return Result.err(
          new HandlerError({
            status: 409,
            message: "Pattern and padding cannot change after allocation",
          }),
        );
      default:
        result satisfies never;
        return panic("Unhandled number series update status");
    }
  },
);
