import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { rateTables } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteRateTableBodySchema = t.Object({
  id: tSafeId("rateTable"),
});

const deleteRateTable = createSafeHandler(
  {
    permissions: { rate: ["delete"] },
    body: deleteRateTableBodySchema,
  },
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.rateTables.findFirst({
          where: { id: { eq: body.id }, workspaceId: { eq: workspaceId } },
          columns: {
            id: true,
            name: true,
            currency: true,
            isDefault: true,
          },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Rate table not found" }),
      );
    }

    if (existing.isDefault) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "Cannot delete the default rate table. " +
            "Set another table as default first.",
        }),
      );
    }

    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .delete(rateTables)
          .where(
            and(
              eq(rateTables.id, body.id),
              eq(rateTables.workspaceId, workspaceId),
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.RATE_TABLE,
          resourceId: body.id,
          changes: {
            deleted: {
              old: {
                name: existing.name,
                currency: existing.currency,
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

export default deleteRateTable;
