import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import type { ScopedDb } from "@/api/db";
import { user } from "@/api/db/auth-schema";
import { timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type ReadTimeEntryByIdHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  id: string;
};

export const readTimeEntryByIdHandler = async ({
  scopedDb,
  workspaceId,
  id,
}: ReadTimeEntryByIdHandlerProps) => {
  const rows = await scopedDb((tx) =>
    tx
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
      ),
  );
  const row = rows.at(0);

  if (!row) {
    return status(404, { message: "Time entry not found" });
  }

  let userName: string | null = null;
  const rowUserId = row.userId;
  if (rowUserId) {
    const [u] = await scopedDb((tx) =>
      tx.select({ name: user.name }).from(user).where(eq(user.id, rowUserId)),
    );
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
