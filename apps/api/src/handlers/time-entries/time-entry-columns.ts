import { timeEntries } from "@/api/db/schema";

/** The columns a time-entry read returns, for the list and the by-id read. */
export const timeEntryReadColumns = {
  id: timeEntries.id,
  userId: timeEntries.userId,
  workItemId: timeEntries.workItemId,
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
};
