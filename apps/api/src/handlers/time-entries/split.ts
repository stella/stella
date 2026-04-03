import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { status, t } from "elysia";

import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import { roundToIncrement } from "@/api/handlers/time-entries/create";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const splitEntryBodySchema = t.Object({
  id: tNanoid,
  splits: t.Array(
    t.Object({
      matterId: tNanoid,
      percentage: t.Integer({ minimum: 1, maximum: 100 }),
    }),
    { minItems: 2, maxItems: 10 },
  ),
});

const splitEntry = createHandler(
  {
    permissions: { timeEntry: ["update"] },
    body: splitEntryBodySchema,
  },
  async ({ scopedDb, workspaceId, body }) => {
    const totalPercentage = body.splits.reduce(
      (sum, s) => sum + s.percentage,
      0,
    );

    if (totalPercentage !== 100) {
      return status(400, {
        message: "Split percentages must total 100",
      });
    }

    const original = await scopedDb((tx) =>
      tx.query.timeEntries.findFirst({
        where: {
          id: body.id,
          workspaceId: { eq: workspaceId },
        },
      }),
    );

    if (!original) {
      return status(404, { message: "Time entry not found" });
    }

    if (
      original.status === BILLING_STATUS.BILLED ||
      original.status === BILLING_STATUS.WRITTEN_OFF
    ) {
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
      const matter = await scopedDb((tx) =>
        tx.query.entities.findFirst({
          where: { id: split.matterId, workspaceId: { eq: workspaceId } },
          columns: { id: true },
        }),
      );

      if (!matter) {
        return status(400, {
          message: `Matter ${split.matterId} not found`,
        });
      }
    }

    const splitGroupId = crypto.randomUUID();
    const now = new Date();
    const newEntryIds: string[] = [];

    // Pre-compute durations, assigning remainder to last split
    // to preserve total duration exactly.
    const durations: number[] = [];
    let remaining = original.durationMinutes;
    for (let i = 0; i < body.splits.length; i++) {
      const currentSplit = body.splits[i];
      if (!currentSplit) {
        panic(`Split at index ${i} is unexpectedly undefined`);
      }
      if (i === body.splits.length - 1) {
        durations.push(Math.max(1, remaining));
      } else {
        const d = Math.max(
          1,
          Math.round(
            (original.durationMinutes * currentSplit.percentage) / 100,
          ),
        );
        durations.push(d);
        remaining -= d;
      }
    }

    // Limit check + delete + inserts in one transaction with
    // advisory lock to prevent TOCTOU on the workspace limit.
    const limitExceeded = await scopedDb(async (tx) => {
      const netNew = body.splits.length - 1;
      if (netNew > 0) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`,
        );
        const currentCount = await tx.$count(
          timeEntries,
          eq(timeEntries.workspaceId, workspaceId),
        );
        if (currentCount + netNew > LIMITS.timeEntriesPerWorkspace) {
          return true;
        }
      }

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
        if (!split || durationMinutes === undefined) {
          continue;
        }
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

        if (entry) {
          newEntryIds.push(entry.id);
        }
      }

      return false;
    });

    if (limitExceeded) {
      return status(400, {
        message: "Workspace time entry limit reached",
      });
    }

    return { splitGroupId, entryIds: newEntryIds };
  },
);

export default splitEntry;
