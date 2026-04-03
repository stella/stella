import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import { roundToIncrement } from "@/api/handlers/time-entries/create";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { pickDefined } from "@/api/lib/pick-defined";

const updateTimeEntryBodySchema = t.Object({
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
  status: t.Optional(
    t.Union([
      t.Literal(BILLING_STATUS.DRAFT),
      t.Literal(BILLING_STATUS.APPROVED),
    ]),
  ),
  rateAtEntry: t.Optional(t.Integer({ minimum: 0 })),
  currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
});

const updateTimeEntryById = createHandler(
  {
    permissions: { timeEntry: ["update"] },
    body: updateTimeEntryBodySchema,
  },
  async ({ scopedDb, workspaceId, body }) => {
    const existing = await scopedDb((tx) =>
      tx.query.timeEntries.findFirst({
        where: {
          id: body.id,
          workspaceId: { eq: workspaceId },
        },
        columns: {
          status: true,
        },
      }),
    );

    if (!existing) {
      return status(404, { message: "Time entry not found" });
    }

    if (
      existing.status === BILLING_STATUS.BILLED ||
      existing.status === BILLING_STATUS.WRITTEN_OFF
    ) {
      return status(400, {
        message: "Cannot edit a billed or written-off entry",
      });
    }

    if (body.matterId !== undefined) {
      const matter = await scopedDb((tx) =>
        tx.query.entities.findFirst({
          where: { id: body.matterId, workspaceId: { eq: workspaceId } },
          columns: { id: true },
        }),
      );

      if (!matter) {
        return status(400, {
          message: "Matter not found in this workspace",
        });
      }
    }

    const updates = {
      ...pickDefined(body, [
        "dateWorked",
        "durationMinutes",
        "narrative",
        "invoiceNarrative",
        "billable",
        "noCharge",
        "matterId",
        "taskCode",
        "activityCode",
        "status",
        "rateAtEntry",
        "currency",
      ]),
      ...(body.durationMinutes !== undefined
        ? { billedMinutes: roundToIncrement(body.durationMinutes) }
        : {}),
      updatedAt: new Date(),
    };

    await scopedDb((tx) =>
      tx
        .update(timeEntries)
        .set(updates)
        .where(
          and(
            eq(timeEntries.id, body.id),
            eq(timeEntries.workspaceId, workspaceId),
          ),
        ),
    );

    return { id: body.id };
  },
);

export default updateTimeEntryById;
