import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { rateEntries } from "@/api/db/schema";
import { loadRateEntry } from "@/api/handlers/rates/existing-rate-entry";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";

const deleteRateEntryBodySchema = t.Object({
  id: tSafeId("rateEntry"),
});

const rateEntryParamsSchema = workspaceParams({
  rateTableId: tSafeId("rateTable"),
});

const deleteRateEntry = createSafeHandler(
  {
    description:
      "Delete a single user's rate line (hourly rate and effective dates) from " +
      "a rate table, leaving the table and its other lines in place. Use " +
      "rates.delete to remove the whole table instead.",
    permissions: { rate: ["delete"] },
    mcp: { type: "capability", reason: "billing_admin" },
    params: rateEntryParamsSchema,
    body: deleteRateEntryBodySchema,
  },
  async function* ({ safeDb, workspaceId, params, body, recordAuditEvent }) {
    const existing = yield* Result.await(
      loadRateEntry({
        safeDb,
        workspaceId,
        rateTableId: params.rateTableId,
        entryId: body.id,
      }),
    );

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
