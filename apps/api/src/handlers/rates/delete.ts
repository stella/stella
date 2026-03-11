import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { rateTables } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";

export const deleteRateTableBodySchema = t.Object({
  id: tNanoid,
});

type DeleteRateTableBodySchema = Static<typeof deleteRateTableBodySchema>;

type DeleteRateTableHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  body: DeleteRateTableBodySchema;
};

export const deleteRateTableHandler = async ({
  scopedDb,
  workspaceId,
  body,
}: DeleteRateTableHandlerProps) => {
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
};
