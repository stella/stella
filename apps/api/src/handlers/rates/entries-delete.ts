import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { rateEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteRateEntryBodySchema = t.Object({
  id: tSafeId("rateEntry"),
});

const rateEntryParamsSchema = workspaceParams({
  rateTableId: tSafeId("rateTable"),
});

const deleteRateEntry = createSafeHandler(
  {
    permissions: { rate: ["delete"] },
    params: rateEntryParamsSchema,
    body: deleteRateEntryBodySchema,
  },
  async function* ({ safeDb, workspaceId, params, body, recordAuditEvent }) {
    const table = yield* Result.await(
      safeDb((tx) =>
        tx.query.rateTables.findFirst({
          where: {
            id: { eq: params.rateTableId },
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true },
        }),
      ),
    );

    if (!table) {
      return Result.err(
        new HandlerError({ status: 404, message: "Rate table not found" }),
      );
    }

    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.rateEntries.findFirst({
          where: {
            id: { eq: body.id },
            rateTableId: { eq: params.rateTableId },
          },
          columns: {
            id: true,
            userId: true,
            hourlyRate: true,
            effectiveFrom: true,
            effectiveTo: true,
          },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Rate entry not found" }),
      );
    }

    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .delete(rateEntries)
          .where(
            and(
              eq(rateEntries.id, body.id),
              eq(rateEntries.rateTableId, params.rateTableId),
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.RATE_ENTRY,
          resourceId: body.id,
          changes: {
            deleted: {
              old: {
                userId: existing.userId,
                hourlyRate: existing.hourlyRate,
                effectiveFrom: existing.effectiveFrom,
                effectiveTo: existing.effectiveTo,
              },
              new: null,
            },
          },
        });
      }),
    );

    return Result.ok({ deleted: true });
  },
);

export default deleteRateEntry;
