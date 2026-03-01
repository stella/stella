import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";
import { nanoid } from "nanoid";

import { db } from "@/api/db";
import { timeEntries } from "@/api/db/schema";
import { roundToIncrement } from "@/api/handlers/time-entries/create";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const splitEntryBodySchema = t.Object({
  id: tNanoid,
  splits: t.Array(
    t.Object({
      matterId: tNanoid,
      percentage: t.Integer({ minimum: 1, maximum: 100 }),
    }),
    { minItems: 2, maxItems: 10 },
  ),
});

type SplitEntryBodySchema = Static<typeof splitEntryBodySchema>;

type SplitEntryHandlerProps = {
  workspaceId: SafeId<"workspace">;
  body: SplitEntryBodySchema;
};

export const splitEntryHandler = async ({
  workspaceId,
  body,
}: SplitEntryHandlerProps) => {
  const totalPercentage = body.splits.reduce((sum, s) => sum + s.percentage, 0);

  if (totalPercentage !== 100) {
    return status(400, {
      message: "Split percentages must total 100",
    });
  }

  const original = await db.query.timeEntries.findFirst({
    where: {
      id: body.id,
      workspaceId,
    },
  });

  if (!original) {
    return status(404, { message: "Time entry not found" });
  }

  if (original.status === "billed" || original.status === "written_off") {
    return status(400, {
      message: "Cannot split a billed or written-off entry",
    });
  }

  if (original.durationMinutes < body.splits.length) {
    return status(400, {
      message:
        "Entry duration too short to split into " +
        `${body.splits.length} parts`,
    });
  }

  // Validate all target matters exist
  for (const split of body.splits) {
    const matter = await db.query.entities.findFirst({
      where: { id: split.matterId, workspaceId },
      columns: { id: true },
    });

    if (!matter) {
      return status(400, {
        message: `Matter ${split.matterId} not found`,
      });
    }
  }

  // Net increase is (splits - 1); check workspace limit.
  const netNew = body.splits.length - 1;
  if (netNew > 0) {
    const currentCount = await db.$count(
      timeEntries,
      eq(timeEntries.workspaceId, workspaceId),
    );
    if (currentCount + netNew > LIMITS.timeEntriesPerWorkspace) {
      return status(400, {
        message: "Workspace time entry limit reached",
      });
    }
  }

  const splitGroupId = nanoid();
  const now = new Date();
  const newEntryIds: string[] = [];

  // Pre-compute durations, assigning remainder to last split
  // to preserve total duration exactly.
  const durations: number[] = [];
  let remaining = original.durationMinutes;
  for (let i = 0; i < body.splits.length; i++) {
    if (i === body.splits.length - 1) {
      durations.push(Math.max(1, remaining));
    } else {
      const d = Math.max(
        1,
        Math.round(
          (original.durationMinutes * body.splits[i].percentage) / 100,
        ),
      );
      durations.push(d);
      remaining -= d;
    }
  }

  await db.transaction(async (tx) => {
    // Delete original entry
    await tx
      .delete(timeEntries)
      .where(
        and(
          eq(timeEntries.id, body.id),
          eq(timeEntries.workspaceId, workspaceId),
        ),
      );

    // Create split entries
    for (let i = 0; i < body.splits.length; i++) {
      const split = body.splits[i];
      const durationMinutes = durations[i];
      const billedMinutes = roundToIncrement(durationMinutes);

      const [entry] = await tx
        .insert(timeEntries)
        .values({
          organizationId: original.organizationId,
          workspaceId,
          userId: original.userId,
          matterId: split.matterId,
          dateWorked: original.dateWorked,
          timezoneId: original.timezoneId,
          durationMinutes,
          billedMinutes,
          rateAtEntry: original.rateAtEntry,
          currency: original.currency,
          narrative: original.narrative,
          invoiceNarrative: original.invoiceNarrative,
          billable: original.billable,
          noCharge: original.noCharge,
          status: original.status,
          source: original.source,
          taskCode: original.taskCode,
          activityCode: original.activityCode,
          splitGroupId,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: timeEntries.id });

      newEntryIds.push(entry.id);
    }
  });

  return { splitGroupId, entryIds: newEntryIds };
};
