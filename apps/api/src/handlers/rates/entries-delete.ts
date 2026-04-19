import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { rateEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteRateEntryBodySchema = t.Object({
  id: tNanoid,
});

const rateEntryParamsSchema = t.Object({
  rateTableId: tNanoid,
});

const deleteRateEntry = createSafeHandler(
  {
    permissions: { rate: ["delete"] },
    params: rateEntryParamsSchema,
    body: deleteRateEntryBodySchema,
  },
  async function* ({ safeDb, workspaceId, params, body }) {
    const table = yield* Result.await(
      safeDb((tx) =>
        tx.query.rateTables.findFirst({
          where: { id: params.rateTableId, workspaceId: { eq: workspaceId } },
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
          where: { id: body.id, rateTableId: params.rateTableId },
          columns: { id: true },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Rate entry not found" }),
      );
    }

    yield* Result.await(
      safeDb((tx) =>
        tx
          .delete(rateEntries)
          .where(
            and(
              eq(rateEntries.id, body.id),
              eq(rateEntries.rateTableId, params.rateTableId),
            ),
          ),
      ),
    );

    return Result.ok({ deleted: true });
  },
);

export default deleteRateEntry;
