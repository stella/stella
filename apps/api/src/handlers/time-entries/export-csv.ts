import { prorateHourlyCents } from "@stll/money";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { member, user } from "@/api/db/auth-schema";
import { timeEntryStatusSchema } from "@/api/db/billing-validators";
import { timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { escapeCSV } from "@/api/lib/csv";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const exportCsvQuerySchema = t.Object({
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
  status: t.Optional(timeEntryStatusSchema),
  matterId: t.Optional(tSafeId("entity")),
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
  if (query.matterId) {
    conditions.push(eq(timeEntries.matterId, query.matterId));
  }

  const rows = await scopedDb((tx) =>
    tx
      .select({
        id: timeEntries.id,
        userId: timeEntries.userId,
        matterId: timeEntries.matterId,
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
        escapeCSV(row.matterId),
        String(row.durationMinutes),
        String(row.billedMinutes),
        (row.rateAtEntry / 100).toFixed(2),
        escapeCSV(row.currency),
        (amount / 100).toFixed(2),
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
