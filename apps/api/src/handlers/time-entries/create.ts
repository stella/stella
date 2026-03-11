import { eq, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { TIME_ENTRY_SOURCE, timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const createTimeEntryBodySchema = t.Object({
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

type CreateTimeEntryBodySchema = Static<typeof createTimeEntryBodySchema>;

type CreateTimeEntryHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: string;
  body: CreateTimeEntryBodySchema;
};

export const createTimeEntryHandler = async ({
  scopedDb,
  organizationId,
  workspaceId,
  userId,
  body,
}: CreateTimeEntryHandlerProps) => {
  const now = new Date();
  // en-CA locale formats dates as YYYY-MM-DD (ISO 8601)
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
    // Advisory lock serializes concurrent inserts without
    // materializing all rows (limit can be 50k+).
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
        organizationId,
        workspaceId,
        userId,
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

    return { id: entry.id };
  });
};

export const roundToIncrement = (minutes: number): number => {
  const inc = LIMITS.billingIncrementMinutes;
  return Math.ceil(minutes / inc) * inc;
};
