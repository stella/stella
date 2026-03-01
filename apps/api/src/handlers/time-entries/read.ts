import { and, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { t, type Static } from "elysia";

import { db } from "@/api/db";
import { user } from "@/api/db/auth-schema";
import {
  timeEntrySourceSchema,
  timeEntryStatusSchema,
} from "@/api/db/billing-validators";
import { timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";

export const readTimeEntriesQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 200 })),
  offset: t.Optional(t.Integer({ minimum: 0 })),
  userId: t.Optional(t.String({ minLength: 1 })),
  matterId: t.Optional(tNanoid),
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
  status: t.Optional(timeEntryStatusSchema),
  source: t.Optional(timeEntrySourceSchema),
  billable: t.Optional(t.BooleanString()),
  hasActiveTimer: t.Optional(t.BooleanString()),
});

type ReadTimeEntriesQuerySchema = Static<typeof readTimeEntriesQuerySchema>;

type ReadTimeEntriesHandlerProps = {
  workspaceId: SafeId<"workspace">;
  query: ReadTimeEntriesQuerySchema;
};

export const readTimeEntriesHandler = async ({
  workspaceId,
  query,
}: ReadTimeEntriesHandlerProps) => {
  const limit = query.limit ?? 100;
  const offset = query.offset ?? 0;

  const conditions = [eq(timeEntries.workspaceId, workspaceId)];

  if (query.userId) {
    conditions.push(eq(timeEntries.userId, query.userId));
  }
  if (query.matterId) {
    conditions.push(eq(timeEntries.matterId, query.matterId));
  }
  if (query.dateFrom) {
    conditions.push(gte(timeEntries.dateWorked, query.dateFrom));
  }
  if (query.dateTo) {
    conditions.push(lte(timeEntries.dateWorked, query.dateTo));
  }
  if (query.status) {
    conditions.push(eq(timeEntries.status, query.status));
  }
  if (query.source) {
    conditions.push(eq(timeEntries.source, query.source));
  }
  if (query.billable !== undefined) {
    conditions.push(eq(timeEntries.billable, query.billable));
  }
  if (query.hasActiveTimer) {
    conditions.push(isNotNull(timeEntries.timerStartedAt));
  }

  const rows = await db
    .select({
      id: timeEntries.id,
      userId: timeEntries.userId,
      matterId: timeEntries.matterId,
      dateWorked: timeEntries.dateWorked,
      timezoneId: timeEntries.timezoneId,
      durationMinutes: timeEntries.durationMinutes,
      billedMinutes: timeEntries.billedMinutes,
      rateAtEntry: timeEntries.rateAtEntry,
      currency: timeEntries.currency,
      narrative: timeEntries.narrative,
      invoiceNarrative: timeEntries.invoiceNarrative,
      billable: timeEntries.billable,
      noCharge: timeEntries.noCharge,
      status: timeEntries.status,
      source: timeEntries.source,
      taskCode: timeEntries.taskCode,
      activityCode: timeEntries.activityCode,
      timerStartedAt: timeEntries.timerStartedAt,
      timerStoppedAt: timeEntries.timerStoppedAt,
      createdAt: timeEntries.createdAt,
    })
    .from(timeEntries)
    .where(and(...conditions))
    .orderBy(timeEntries.dateWorked)
    .limit(limit)
    .offset(offset);

  // Batch-fetch user names
  const userIds = new Set<string>();
  for (const row of rows) {
    if (row.userId) {
      userIds.add(row.userId);
    }
  }

  const usersResult =
    userIds.size > 0
      ? await db
          .select({ id: user.id, name: user.name })
          .from(user)
          .where(inArray(user.id, Array.from(userIds)))
      : [];

  const userMap = new Map(usersResult.map((u) => [u.id, u.name]));

  return rows.map((row) => ({
    ...row,
    userName: row.userId ? (userMap.get(row.userId) ?? null) : null,
    timerStartedAt: row.timerStartedAt?.toISOString() ?? null,
    timerStoppedAt: row.timerStoppedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
};
