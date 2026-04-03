import { eq, sql } from "drizzle-orm";
import { status, t } from "elysia";

import { TIME_ENTRY_SOURCE, timeEntries } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const createTimeEntryBodySchema = t.Object({
  matterId: tNanoid,
  dateWorked: t.String({ format: "date" }),
  timezoneId: t.String({ minLength: 1, maxLength: 64 }),
  durationMinutes: t.Integer({ minimum: 1 }),
  rateAtEntry: t.Integer({ minimum: 0 }),
  currency: t.String({ minLength: 3, maxLength: 3 }),
  narrative: t.String({ minLength: 1, maxLength: 10_000 }),
  billable: t.Optional(t.Boolean()),
  taskCode: t.Optional(t.Nullable(t.String({ maxLength: 20 }))),
  activityCode: t.Optional(t.Nullable(t.String({ maxLength: 20 }))),
});

const createTimeEntry = createHandler(
  {
    permissions: { timeEntry: ["create"] },
    body: createTimeEntryBodySchema,
  },
  async ({ scopedDb, session, workspaceId, user, body }) => {
    const now = new Date();
    const todayStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: body.timezoneId,
    }).format(now);
    const dateWorked = new Date(`${body.dateWorked}T00:00:00`);
    const today = new Date(`${todayStr}T00:00:00`);

    if (dateWorked > today) {
      return status(400, {
        message: "Date worked cannot be in the future",
      });
    }

    const maxAgeCutoff = new Date(today);
    maxAgeCutoff.setDate(maxAgeCutoff.getDate() - LIMITS.timeEntryMaxAgeDays);
    if (dateWorked < maxAgeCutoff) {
      return status(400, {
        message: `Date worked cannot be more than ${LIMITS.timeEntryMaxAgeDays} days ago`,
      });
    }

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

    const billedMinutes = roundToIncrement(body.durationMinutes);

    return scopedDb(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`,
      );
      const count = await tx.$count(
        timeEntries,
        eq(timeEntries.workspaceId, workspaceId),
      );

      if (count >= LIMITS.timeEntriesPerWorkspace) {
        return status(400, {
          message: "Time entries limit reached for this workspace",
        });
      }

      const [entry] = await tx
        .insert(timeEntries)
        .values({
          organizationId: session.activeOrganizationId,
          workspaceId,
          userId: user.id,
          matterId: body.matterId,
          dateWorked: body.dateWorked,
          timezoneId: body.timezoneId,
          durationMinutes: body.durationMinutes,
          billedMinutes,
          rateAtEntry: body.rateAtEntry,
          currency: body.currency,
          narrative: body.narrative,
          billable: body.billable ?? true,
          taskCode: body.taskCode ?? null,
          activityCode: body.activityCode ?? null,
          source: TIME_ENTRY_SOURCE.MANUAL,
        })
        .returning({ id: timeEntries.id });

      if (!entry) {
        return status(500, { message: "Failed to create time entry" });
      }
      return { id: entry.id };
    });
  },
);

export default createTimeEntry;

export const roundToIncrement = (minutes: number): number => {
  const inc = LIMITS.billingIncrementMinutes;
  return Math.ceil(minutes / inc) * inc;
};
