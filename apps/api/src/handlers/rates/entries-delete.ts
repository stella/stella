import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { rateEntries } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

const deleteRateEntryBodySchema = t.Object({
  id: tNanoid,
});

const rateEntryParamsSchema = t.Object({
  rateTableId: tNanoid,
});

const deleteRateEntry = createHandler(
  {
    permissions: { rate: ["delete"] },
    params: rateEntryParamsSchema,
    body: deleteRateEntryBodySchema,
  },
  async ({ scopedDb, workspaceId, params, body }) => {
    const table = await scopedDb((tx) =>
      tx.query.rateTables.findFirst({
        where: { id: params.rateTableId, workspaceId: { eq: workspaceId } },
        columns: { id: true },
      }),
    );

    if (!table) {
      return status(404, { message: "Rate table not found" });
    }

    const existing = await scopedDb((tx) =>
      tx.query.rateEntries.findFirst({
        where: { id: body.id, rateTableId: params.rateTableId },
        columns: { id: true },
      }),
    );

    if (!existing) {
      return status(404, { message: "Rate entry not found" });
    }

    await scopedDb((tx) =>
      tx
        .delete(rateEntries)
        .where(
          and(
            eq(rateEntries.id, body.id),
            eq(rateEntries.rateTableId, params.rateTableId),
          ),
        ),
    );

    return { deleted: true };
  },
);

export default deleteRateEntry;
