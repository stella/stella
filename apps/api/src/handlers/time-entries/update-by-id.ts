import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { timeEntries } from "@/api/db/schema";
import { roundToIncrement } from "@/api/handlers/time-entries/create";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";

export const updateTimeEntryBodySchema = t.Object({
  id: tNanoid,
  dateWorked: t.Optional(t.String({ format: "date" })),
  durationMinutes: t.Optional(t.Integer({ minimum: 1 })),
  narrative: t.Optional(t.String({ minLength: 1, maxLength: 10_000 })),
  invoiceNarrative: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
  billable: t.Optional(t.Boolean()),
  noCharge: t.Optional(t.Boolean()),
  matterId: t.Optional(tNanoid),
  taskCode: t.Optional(t.Nullable(t.String({ maxLength: 20 }))),
  activityCode: t.Optional(t.Nullable(t.String({ maxLength: 20 }))),
  status: t.Optional(t.Union([t.Literal("draft"), t.Literal("approved")])),
  rateAtEntry: t.Optional(t.Integer({ minimum: 0 })),
  currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
});

type UpdateTimeEntryBodySchema = Static<typeof updateTimeEntryBodySchema>;

type UpdateTimeEntryByIdHandlerProps = {
  workspaceId: SafeId<"workspace">;
  body: UpdateTimeEntryBodySchema;
};

export const updateTimeEntryByIdHandler = async ({
  workspaceId,
  body,
}: UpdateTimeEntryByIdHandlerProps) => {
  const existing = await db.query.timeEntries.findFirst({
    where: {
      id: body.id,
      workspaceId,
    },
    columns: {
      status: true,
    },
  });

  if (!existing) {
    return status(404, { message: "Time entry not found" });
  }

  if (existing.status === "billed" || existing.status === "written_off") {
    return status(400, {
      message: "Cannot edit a billed or written-off entry",
    });
  }

  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (body.dateWorked !== undefined) {
    updates.dateWorked = body.dateWorked;
  }
  if (body.durationMinutes !== undefined) {
    updates.durationMinutes = body.durationMinutes;
    updates.billedMinutes = roundToIncrement(body.durationMinutes);
  }
  if (body.narrative !== undefined) {
    updates.narrative = body.narrative;
  }
  if (body.invoiceNarrative !== undefined) {
    updates.invoiceNarrative = body.invoiceNarrative;
  }
  if (body.billable !== undefined) {
    updates.billable = body.billable;
  }
  if (body.noCharge !== undefined) {
    updates.noCharge = body.noCharge;
  }
  if (body.matterId !== undefined) {
    const matter = await db.query.entities.findFirst({
      where: { id: body.matterId, workspaceId },
      columns: { id: true },
    });

    if (!matter) {
      return status(400, {
        message: "Matter not found in this workspace",
      });
    }

    updates.matterId = body.matterId;
  }
  if (body.taskCode !== undefined) {
    updates.taskCode = body.taskCode;
  }
  if (body.activityCode !== undefined) {
    updates.activityCode = body.activityCode;
  }
  if (body.status !== undefined) {
    updates.status = body.status;
  }
  if (body.rateAtEntry !== undefined) {
    updates.rateAtEntry = body.rateAtEntry;
  }
  if (body.currency !== undefined) {
    updates.currency = body.currency;
  }

  await db
    .update(timeEntries)
    .set(updates)
    .where(
      and(
        eq(timeEntries.id, body.id),
        eq(timeEntries.workspaceId, workspaceId),
      ),
    );

  return { id: body.id };
};
