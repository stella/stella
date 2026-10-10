import { Result } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import { numberSeries } from "@/api/db/schema";
import { numberSeriesParams } from "@/api/handlers/number-series/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description: "Archive a number series so it cannot allocate another number.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  params: numberSeriesParams,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session, recordAuditEvent }) {
    const archived = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .select({
            id: numberSeries.id,
            documentType: numberSeries.documentType,
          })
          .from(numberSeries)
          .where(
            and(
              eq(numberSeries.id, params.numberSeriesId),
              eq(numberSeries.organizationId, session.activeOrganizationId),
              isNull(numberSeries.archivedAt),
            ),
          )
          .limit(1);
        const current = rows.at(0);
        if (!current) {
          return null;
        }
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${session.activeOrganizationId}:number-series:${current.documentType}`}, 0))`,
        );
        const updated = await tx
          .update(numberSeries)
          .set({
            archivedAt: new Date(),
            isDefault: false,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(numberSeries.id, current.id),
              eq(numberSeries.organizationId, session.activeOrganizationId),
              isNull(numberSeries.archivedAt),
            ),
          )
          .returning({ id: numberSeries.id });
        const row = updated.at(0);
        if (row) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.NUMBER_SERIES,
            resourceId: row.id,
            workspaceId: null,
            metadata: { change: "archived" },
          });
        }
        return row ?? null;
      }),
    );
    if (!archived) {
      return Result.err(
        new HandlerError({ status: 404, message: "Number series not found" }),
      );
    }
    return Result.ok({ id: archived.id, archived: true });
  },
);
