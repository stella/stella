import { Result } from "better-result";
import { and } from "drizzle-orm";

import { timeEntryAmount } from "@stll/money";

import { timeEntries } from "@/api/db/schema";
import { exportAmountText } from "@/api/handlers/time-entries/export-amount";
import {
  loadTimekeeperNames,
  timeEntryExportConditions,
  timeEntryExportQuerySchema,
} from "@/api/handlers/time-entries/export-query";
import type { TimeEntryExportHandlerProps } from "@/api/handlers/time-entries/export-query";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { escapeCSV } from "@/api/lib/csv";
import { LIMITS } from "@/api/lib/limits";

export const exportCsvHandler = async ({
  scopedDb,
  workspaceId,
  organizationId,
  query,
}: TimeEntryExportHandlerProps) => {
  const conditions = timeEntryExportConditions({ workspaceId, query });

  const rows = await scopedDb((tx) =>
    tx
      .select({
        id: timeEntries.id,
        activityGroup: timeEntries.activityGroup,
        userId: timeEntries.userId,
        workItemId: timeEntries.workItemId,
        dateWorked: timeEntries.dateWorked,
        durationMinutes: timeEntries.durationMinutes,
        billedMinutes: timeEntries.billedMinutes,
        rateAtEntry: timeEntries.rateAtEntry,
        noCharge: timeEntries.noCharge,
        currency: timeEntries.currency,
        narrative: timeEntries.narrative,
        invoiceNarrative: timeEntries.invoiceNarrative,
        billable: timeEntries.billable,
        status: timeEntries.status,
        taskCode: timeEntries.taskCode,
        activityCode: timeEntries.activityCode,
      })
      .from(timeEntries)
      .where(and(...conditions))
      .orderBy(timeEntries.dateWorked)
      .limit(LIMITS.exportRowLimit),
  );

  const userMap = await loadTimekeeperNames({
    scopedDb,
    organizationId,
    rows,
  });

  const headers = [
    "Date",
    "User",
    "Matter ID",
    "Activity Group",
    "Work Item ID",
    "Duration (min)",
    "Billed (min)",
    "Rate",
    "Currency",
    "Amount",
    "Billable",
    "Status",
    "Task Code",
    "Activity Code",
    "Narrative",
    "Invoice Narrative",
  ];

  const csvRows = [headers.join(",")];

  for (const row of rows) {
    const amount = timeEntryAmount(row);
    csvRows.push(
      [
        escapeCSV(row.dateWorked),
        escapeCSV(row.userId ? (userMap.get(row.userId) ?? "") : ""),
        escapeCSV(workspaceId),
        escapeCSV(row.activityGroup),
        escapeCSV(row.workItemId ?? ""),
        String(row.durationMinutes),
        String(row.billedMinutes),
        exportAmountText(row.rateAtEntry, row.currency),
        escapeCSV(row.currency),
        exportAmountText(amount, row.currency),
        row.billable ? "Yes" : "No",
        escapeCSV(row.status),
        escapeCSV(row.taskCode ?? ""),
        escapeCSV(row.activityCode ?? ""),
        escapeCSV(row.narrative),
        escapeCSV(row.invoiceNarrative ?? ""),
      ].join(","),
    );
  }

  return csvRows.join("\n");
};

const config = {
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  description:
    "Export a matter's client time entries as CSV text, one row per entry with " +
    "date, timekeeper name, activity group, work item, minutes, rate, amount, billable flag, " +
    "status, task and activity codes, and narratives. Filter by date-worked " +
    "range, status, and work item. Unlike the LEDES export this includes " +
    "non-billable and written-off entries; the row count is capped.",
  permissions: { timeEntry: ["approve"] },
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "billing_admin",
    consumesServices: false,
  },
  access: "read",
  query: timeEntryExportQuerySchema,
} satisfies WorkspaceHandlerConfig;

const exportCsv = createSafeHandler(
  config,
  async function* ({ query, scopedDb, session, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await exportCsvHandler({
            workspaceId,
            organizationId: session.activeOrganizationId,
            query,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export default exportCsv;
