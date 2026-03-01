import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import { db } from "@/api/db";
import { user } from "@/api/db/auth-schema";
import { timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type ReadTimeEntryByIdHandlerProps = {
  workspaceId: SafeId<"workspace">;
  id: string;
};

export const readTimeEntryByIdHandler = async ({
  workspaceId,
  id,
}: ReadTimeEntryByIdHandlerProps) => {
  const [row] = await db
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
      updatedAt: timeEntries.updatedAt,
    })
    .from(timeEntries)
    .where(
      and(eq(timeEntries.id, id), eq(timeEntries.workspaceId, workspaceId)),
    );

  if (!row) {
    return status(404, { message: "Time entry not found" });
  }

  let userName: string | null = null;
  if (row.userId) {
    const [u] = await db
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, row.userId));
    userName = u?.name ?? null;
  }

  return {
    ...row,
    userName,
    timerStartedAt: row.timerStartedAt?.toISOString() ?? null,
    timerStoppedAt: row.timerStoppedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
};
