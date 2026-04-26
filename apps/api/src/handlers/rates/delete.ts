import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { rateTables } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
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
  async function* ({ safeDb, workspaceId, body }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.rateTables.findFirst({
          where: { id: { eq: body.id }, workspaceId: { eq: workspaceId } },
          columns: { id: true, isDefault: true },
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
      safeDb((tx) =>
        tx
          .delete(rateTables)
          .where(
            and(
              eq(rateTables.id, body.id),
              eq(rateTables.workspaceId, workspaceId),
            ),
          ),
      ),
    );

    return Result.ok({ deleted: true });
  },
);

export default deleteRateTable;
