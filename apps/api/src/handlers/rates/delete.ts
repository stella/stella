import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { rateTables } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

const deleteRateTableBodySchema = t.Object({
  id: tNanoid,
});

const deleteRateTable = createHandler(
  {
    permissions: { rate: ["delete"] },
    body: deleteRateTableBodySchema,
  },
  async ({ scopedDb, workspaceId, body }) => {
    const existing = await scopedDb((tx) =>
      tx.query.rateTables.findFirst({
        where: { id: body.id, workspaceId: { eq: workspaceId } },
        columns: { id: true, isDefault: true },
      }),
    );

    if (!existing) {
      return status(404, { message: "Rate table not found" });
    }

    if (existing.isDefault) {
      return status(400, {
        message:
          "Cannot delete the default rate table. " +
          "Set another table as default first.",
      });
    }

    await scopedDb((tx) =>
      tx
        .delete(rateTables)
        .where(
          and(
            eq(rateTables.id, body.id),
            eq(rateTables.workspaceId, workspaceId),
          ),
        ),
    );

    return { deleted: true };
  },
);

export default deleteRateTable;
