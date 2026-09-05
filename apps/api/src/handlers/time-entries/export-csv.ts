import { Result } from "better-result";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { prorateHourlyCents } from "@stll/money";

import { member, user } from "@/api/db/auth-schema";
import { timeEntryStatusSchema } from "@/api/db/billing-validators";
import type { ScopedDb } from "@/api/db/safe-db";
import { timeEntries } from "@/api/db/schema";
import { exportAmountText } from "@/api/handlers/time-entries/export-amount";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { escapeCSV } from "@/api/lib/csv";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const exportCsvQuerySchema = t.Object({
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
  status: t.Optional(timeEntryStatusSchema),
  workItemId: t.Optional(tSafeId("entity")),
});

type ExportCsvQuerySchema = Static<typeof exportCsvQuerySchema>;

type ExportCsvHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  query: ExportCsvQuerySchema;
};

export const exportCsvHandler = async ({
  scopedDb,
  workspaceId,
  organizationId,
  query,
}: ExportCsvHandlerProps) => {
  const conditions = [eq(timeEntries.workspaceId, workspaceId)];

  if (query.dateFrom) {
    conditions.push(gte(timeEntries.dateWorked, query.dateFrom));
  }
  if (query.dateTo) {
    conditions.push(lte(timeEntries.dateWorked, query.dateTo));
  }
  if (query.status) {
    conditions.push(eq(timeEntries.status, query.status));
  }
  if (query.workItemId) {
    conditions.push(eq(timeEntries.workItemId, query.workItemId));
  }

  const rows = await scopedDb((tx) =>
    tx
      .select({
        id: timeEntries.id,
        userId: timeEntries.userId,
        workItemId: timeEntries.workItemId,
        dateWorked: timeEntries.dateWorked,
        durationMinutes: timeEntries.durationMinutes,
        billedMinutes: timeEntries.billedMinutes,
        rateAtEntry: timeEntries.rateAtEntry,
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

  // Batch-fetch user names
  const userIds = new Set<string>();
  for (const row of rows) {
    if (row.userId) {
      userIds.add(row.userId);
    }
  }

  const usersResult =
    userIds.size > 0
      ? await scopedDb((tx) =>
          tx
            .select({ id: user.id, name: user.name })
            .from(member)
            .innerJoin(user, eq(member.userId, user.id))
            .where(
              and(
                eq(member.organizationId, organizationId),
                inArray(member.userId, [...userIds]),
              ),
            ),
        )
      : [];

  const userMap = new Map(usersResult.map((u) => [u.id, u.name]));

  const headers = [
    "Date",
    "User",
    "Matter ID",
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
    const amount = prorateHourlyCents({
      billedMinutes: row.billedMinutes,
      hourlyRateCents: row.rateAtEntry,
    });
    csvRows.push(
      [
        escapeCSV(row.dateWorked),
        escapeCSV(row.userId ? (userMap.get(row.userId) ?? "") : ""),
        escapeCSV(workspaceId),
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
  description:
    "Export a matter's time entries as CSV text, one row per entry with " +
    "date, timekeeper name, work item, minutes, rate, amount, billable flag, " +
    "status, task and activity codes, and narratives. Filter by date-worked " +
    "range, status, and work item. Unlike the LEDES export this includes " +
    "non-billable and written-off entries; the row count is capped.",
  permissions: { timeEntry: ["approve"] },
  mcp: { type: "capability", reason: "billing_admin" },
  access: "read",
  query: exportCsvQuerySchema,
} satisfies HandlerConfig;

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
