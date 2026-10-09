import { panic, Result } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import { numberSeries } from "@/api/db/schema";
import { numberSeriesParams } from "@/api/handlers/number-series/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description: "Set the default active series for its document type.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  params: numberSeriesParams,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const target = await tx.query.numberSeries.findFirst({
          columns: { id: true, documentType: true },
          where: {
            id: { eq: params.numberSeriesId },
            organizationId: { eq: session.activeOrganizationId },
            archivedAt: { isNull: true },
          },
        });
        if (!target) {
          return null;
        }
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${session.activeOrganizationId}:number-series:${target.documentType}`}, 0))`,
        );
        const active = await tx.query.numberSeries.findFirst({
          columns: { id: true, sellerProfileId: true },
          where: {
            id: { eq: target.id },
            organizationId: { eq: session.activeOrganizationId },
            archivedAt: { isNull: true },
          },
        });
        if (!active) {
          return null;
        }
        const current = await tx
          .update(numberSeries)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(
            and(
              eq(numberSeries.organizationId, session.activeOrganizationId),
              eq(numberSeries.documentType, target.documentType),
              active.sellerProfileId === null
                ? isNull(numberSeries.sellerProfileId)
                : eq(numberSeries.sellerProfileId, active.sellerProfileId),
              eq(numberSeries.isDefault, true),
              isNull(numberSeries.archivedAt),
            ),
          )
          .returning({ id: numberSeries.id });
        const updated = await tx
          .update(numberSeries)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(
            and(
              eq(numberSeries.id, target.id),
              eq(numberSeries.organizationId, session.activeOrganizationId),
              isNull(numberSeries.archivedAt),
            ),
          )
          .returning({ id: numberSeries.id });
        const row =
          updated.at(0) ?? panic("Failed to set default number series");
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.NUMBER_SERIES,
          resourceId: row.id,
          workspaceId: null,
          metadata: {
            change: "set_default",
            previousDefaultId: current.at(0)?.id ?? null,
          },
        });
        return row;
      }),
    );
    if (!result) {
      return Result.err(
        new HandlerError({ status: 404, message: "Number series not found" }),
      );
    }
    return Result.ok({ id: result.id, isDefault: true });
  },
);
