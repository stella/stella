import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { rateEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";

export const deleteRateEntryBodySchema = t.Object({
  id: tNanoid,
});

type DeleteRateEntryBodySchema = Static<typeof deleteRateEntryBodySchema>;

type DeleteRateEntryHandlerProps = {
  workspaceId: SafeId<"workspace">;
  rateTableId: string;
  body: DeleteRateEntryBodySchema;
};

export const deleteRateEntryHandler = async ({
  workspaceId,
  rateTableId,
  body,
}: DeleteRateEntryHandlerProps) => {
  const table = await db.query.rateTables.findFirst({
    where: { id: rateTableId, workspaceId: { eq: workspaceId } },
    columns: { id: true },
  });

  if (!table) {
    return status(404, { message: "Rate table not found" });
  }

  const existing = await db.query.rateEntries.findFirst({
    where: { id: body.id, rateTableId },
    columns: { id: true },
  });

  if (!existing) {
    return status(404, { message: "Rate entry not found" });
  }

  await db
    .delete(rateEntries)
    .where(
      and(
        eq(rateEntries.id, body.id),
        eq(rateEntries.rateTableId, rateTableId),
      ),
    );

  return { deleted: true };
};
