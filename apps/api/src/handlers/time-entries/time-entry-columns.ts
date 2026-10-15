import {
  entityContextId,
  entityContextReference,
} from "@/api/db/entity-feature-policies";
import { timeEntries } from "@/api/db/schema";

/** The columns a time-entry read returns, for the list and the by-id read. */
export const timeEntryReadColumns = {
  id: timeEntries.id,
  activityGroup: timeEntries.activityGroup,
  userId: timeEntries.userId,
  approverUserId: timeEntries.approverUserId,
  approvedByUserId: timeEntries.approvedByUserId,
  approvedAt: timeEntries.approvedAt,
  returnedByUserId: timeEntries.returnedByUserId,
  returnedAt: timeEntries.returnedAt,
  returnComment: timeEntries.returnComment,
  workItemId: entityContextId(timeEntries.workItemId),
  dateWorked: timeEntries.dateWorked,
  timezoneId: timeEntries.timezoneId,
  durationMinutes: timeEntries.durationMinutes,
  billedMinutes: timeEntries.billedMinutes,
  rateAtEntry: timeEntries.rateAtEntry,
  currency: timeEntries.currency,
  narrative: timeEntries.narrative,
  narrativeLanguage: timeEntries.narrativeLanguage,
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

/** Context state is computed from the same persisted reference as workItemId. */
export const timeEntryContextColumns = {
  workItemReference: entityContextReference(timeEntries.workItemId),
};
