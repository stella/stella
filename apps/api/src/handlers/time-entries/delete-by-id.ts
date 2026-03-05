import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";

export const deleteTimeEntryBodySchema = t.Object({
  id: tNanoid,
});

type DeleteTimeEntryBodySchema = Static<typeof deleteTimeEntryBodySchema>;

type DeleteTimeEntryByIdHandlerProps = {
  workspaceId: SafeId<"workspace">;
  body: DeleteTimeEntryBodySchema;
};

export const deleteTimeEntryByIdHandler = async ({
  workspaceId,
  body,
}: DeleteTimeEntryByIdHandlerProps) => {
  const existing = await db.query.timeEntries.findFirst({
    where: {
      id: body.id,
      workspaceId: { eq: workspaceId },
    },
    columns: {
      status: true,
    },
  });

  if (!existing) {
    return status(404, { message: "Time entry not found" });
  }

  if (existing.status === BILLING_STATUS.DRAFT) {
    await db
      .delete(timeEntries)
      .where(
        and(
          eq(timeEntries.id, body.id),
          eq(timeEntries.workspaceId, workspaceId),
        ),
      );
    return { deleted: true };
  }

  // Non-draft entries get written off instead of deleted
  await db
    .update(timeEntries)
    .set({
      status: BILLING_STATUS.WRITTEN_OFF,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(timeEntries.id, body.id),
        eq(timeEntries.workspaceId, workspaceId),
      ),
    );

  return { deleted: false };
};
