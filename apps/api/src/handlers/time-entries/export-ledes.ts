import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { t, type Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { user } from "@/api/db/auth-schema";
import { timeEntryStatusSchema } from "@/api/db/billing-validators";
import { timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

export const exportLedesQuerySchema = t.Object({
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
  status: t.Optional(timeEntryStatusSchema),
  matterId: t.Optional(t.String()),
});

type ExportLedesQuerySchema = Static<typeof exportLedesQuerySchema>;

type ExportLedesHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  query: ExportLedesQuerySchema;
};

/**
 * Generates a LEDES 1998B formatted export.
 * LEDES 1998B uses pipe-delimited lines with a fixed header row.
 */
export const exportLedesHandler = async ({
  scopedDb,
  workspaceId,
  query,
}: ExportLedesHandlerProps) => {
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
            .from(user)
            .where(inArray(user.id, Array.from(userIds))),
        )
      : [];

  const userMap = new Map(usersResult.map((u) => [u.id, u.name]));

  // LEDES 1998B header
  const header =
    "INVOICE_DATE|INVOICE_NUMBER|CLIENT_ID" +
    "|LAW_FIRM_MATTER_ID" +
    "|INVOICE_TOTAL|BILLING_START_DATE|BILLING_END_DATE" +
    "|INVOICE_DESCRIPTION|LINE_ITEM_NUMBER" +
    "|EXP/FEE/INV_ADJ_TYPE" +
    "|LINE_ITEM_NUMBER_OF_UNITS" +
    "|LINE_ITEM_ADJUSTMENT_AMOUNT" +
    "|LINE_ITEM_TOTAL|LINE_ITEM_DATE" +
    "|LINE_ITEM_TASK_CODE" +
    "|LINE_ITEM_EXPENSE_CODE|LINE_ITEM_ACTIVITY_CODE" +
    "|TIMEKEEPER_ID|LINE_ITEM_DESCRIPTION" +
    "|LAW_FIRM_ID|LINE_ITEM_UNIT_COST|TIMEKEEPER_NAME" +
    "|LINE_ITEM_TASK_DESCRIPTION" +
    "|LINE_ITEM_ACTIVITY_DESCRIPTION[]";

  const lines = ["LEDES1998B[]", header];
  const now = new Date();
  const invoiceDate = now.toISOString().split("T")[0].replace(/-/g, "");

  let lineItemNumber = 0;

  for (const row of rows) {
    lineItemNumber++;
    const hours = row.billedMinutes / 60;
    const rate = row.rateAtEntry / 100;
    const total = hours * rate;
    const dateFormatted = row.dateWorked.replace(/-/g, "");
    const userName = row.userId ? (userMap.get(row.userId) ?? "") : "";
    const narrative = (row.invoiceNarrative ?? row.narrative).replace(
      /\|/g,
      " ",
    );

    lines.push(
      `${[
        invoiceDate,
        "", // INVOICE_NUMBER
        "", // CLIENT_ID
        row.matterId,
        total.toFixed(2),
        dateFormatted,
        dateFormatted,
        "", // INVOICE_DESCRIPTION
        String(lineItemNumber),
        "F", // FEE type
        hours.toFixed(2),
        "0.00", // ADJUSTMENT
        total.toFixed(2),
        dateFormatted,
        row.taskCode ?? "",
        "", // EXPENSE_CODE
        row.activityCode ?? "",
        row.userId ?? "",
        narrative,
        "", // LAW_FIRM_ID
        rate.toFixed(2),
        userName,
        "", // TASK_DESCRIPTION
        "", // ACTIVITY_DESCRIPTION
      ].join("|")}[]`,
    );
  }

  return lines.join("\n");
};
