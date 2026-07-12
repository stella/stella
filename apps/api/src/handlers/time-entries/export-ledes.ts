import { Result } from "better-result";
import { and, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { MoneyTotals, prorateHourlyCents } from "@stll/money";
import type { CentsAmount } from "@stll/money";

import { member, user } from "@/api/db/auth-schema";
import { timeEntryStatusSchema } from "@/api/db/billing-validators";
import type { ScopedDb } from "@/api/db/safe-db";
import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

export const exportLedesQuerySchema = t.Object({
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
  status: t.Optional(timeEntryStatusSchema),
  matterId: t.Optional(tSafeId("entity")),
});

type ExportLedesQuerySchema = Static<typeof exportLedesQuerySchema>;

type ExportLedesHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  query: ExportLedesQuerySchema;
};

/**
 * Neutralize a user-controlled value for a LEDES 1998B field. The format is
 * pipe-delimited with one record per line and has no quoting mechanism, so a
 * value containing a pipe or a line break would split a field or inject a
 * spurious record. Replace those delimiters with spaces.
 */
export const escapeLedesField = (value: string): string =>
  value.replace(/[\r\n|]/gu, " ");

type LedesLineItem = {
  matterId: SafeId<"entity">;
  dateWorked: string;
  totalCents: CentsAmount;
  currency: string;
  hours: number;
  taskCode: string;
  activityCode: string;
  userId: string;
  narrative: string;
  rateAtEntry: number;
  userName: string;
};

/**
 * Generates a LEDES 1998B formatted export.
 * LEDES 1998B uses pipe-delimited lines with a fixed header row.
 */
export const exportLedesHandler = async ({
  scopedDb,
  workspaceId,
  organizationId,
  query,
}: ExportLedesHandlerProps) => {
  const conditions = [eq(timeEntries.workspaceId, workspaceId)];

  // LEDES 1998B is a client e-billing file: it must contain only billable,
  // charged line items, never internal non-billable or written-off time.
  conditions.push(eq(timeEntries.billable, true));
  conditions.push(eq(timeEntries.noCharge, false));
  conditions.push(ne(timeEntries.status, BILLING_STATUS.WRITTEN_OFF));

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
        noCharge: timeEntries.noCharge,
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

  // First pass: apply the same billing-integrity guard as the SQL filter
  // (defensive: a non-billable, no-charge, or written-off entry must never
  // produce a charged line), then collect the per-line data needed both to
  // compute the invoice-level aggregates and to emit each row.
  const lineItems: LedesLineItem[] = [];

  for (const row of rows) {
    if (
      !row.billable ||
      row.noCharge ||
      row.status === BILLING_STATUS.WRITTEN_OFF
    ) {
      continue;
    }
    const totalCents = prorateHourlyCents({
      billedMinutes: row.billedMinutes,
      hourlyRateCents: row.rateAtEntry,
    });
    const userName = escapeLedesField(
      row.userId ? (userMap.get(row.userId) ?? "") : "",
    );
    const narrative = escapeLedesField(row.invoiceNarrative ?? row.narrative);

    lineItems.push({
      matterId: row.matterId,
      dateWorked: row.dateWorked,
      totalCents,
      currency: row.currency,
      hours: row.billedMinutes / 60,
      taskCode: escapeLedesField(row.taskCode ?? ""),
      activityCode: escapeLedesField(row.activityCode ?? ""),
      userId: row.userId ?? "",
      narrative,
      rateAtEntry: row.rateAtEntry,
      userName,
    });
  }

  // Invoice-level aggregates: INVOICE_TOTAL is the total for the whole
  // invoice/batch (not a single line), and BILLING_START_DATE/
  // BILLING_END_DATE are the min/max dates across the included lines. Per
  // the LEDES 1998B spec, both are repeated identically on every row.
  // Currency is a per-entry column, so accumulate through MoneyTotals: it
  // buckets by currency and makes a cross-currency sum structurally
  // unreachable.
  let billingStart = "";
  let billingEnd = "";
  const invoiceTotals = new MoneyTotals();
  for (const item of lineItems) {
    if (!billingStart || item.dateWorked < billingStart) {
      billingStart = item.dateWorked;
    }
    if (!billingEnd || item.dateWorked > billingEnd) {
      billingEnd = item.dateWorked;
    }
    invoiceTotals.add(item.currency, item.totalCents);
  }

  // LEDES 1998B has no currency field, so a mixed-currency batch cannot be
  // represented at all: there is no honest value to put in INVOICE_TOTAL.
  const totalsEntries = invoiceTotals.entries();
  if (totalsEntries.length > 1) {
    const currencies = totalsEntries.map((entry) => entry.currency).join(", ");
    return Result.err(
      new HandlerError({
        status: 400,
        message: `LEDES 1998B cannot represent a batch spanning multiple currencies (${currencies}); export a single currency at a time by narrowing the date or matter filters`,
      }),
    );
  }
  const invoiceTotalCents = totalsEntries.at(0)?.amountCents ?? 0;
  const invoiceTotalFormatted = (invoiceTotalCents / 100).toFixed(2);
  const billingStartFormatted = billingStart.replace(/-/gu, "");
  const billingEndFormatted = billingEnd.replace(/-/gu, "");

  const lines = ["LEDES1998B[]", header];
  const now = new Date();
  const invoiceDate = (now.toISOString().split("T")[0] ?? "").replace(
    /-/gu,
    "",
  );

  let lineItemNumber = 0;

  for (const item of lineItems) {
    lineItemNumber++;
    const dateFormatted = item.dateWorked.replace(/-/gu, "");

    lines.push(
      `${[
        invoiceDate,
        "", // INVOICE_NUMBER
        "", // CLIENT_ID
        item.matterId,
        invoiceTotalFormatted,
        billingStartFormatted,
        billingEndFormatted,
        "", // INVOICE_DESCRIPTION
        String(lineItemNumber),
        "F", // FEE type
        item.hours.toFixed(2),
        "0.00", // ADJUSTMENT
        (item.totalCents / 100).toFixed(2),
        dateFormatted,
        item.taskCode,
        "", // EXPENSE_CODE
        item.activityCode,
        item.userId,
        item.narrative,
        "", // LAW_FIRM_ID
        (item.rateAtEntry / 100).toFixed(2),
        item.userName,
        "", // TASK_DESCRIPTION
        "", // ACTIVITY_DESCRIPTION
      ].join("|")}[]`,
    );
  }

  return Result.ok(lines.join("\n"));
};

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "billing_admin" },
  query: exportLedesQuerySchema,
} satisfies HandlerConfig;

const exportLedes = createSafeHandler(
  config,
  async function* ({ query, scopedDb, session, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await exportLedesHandler({
            workspaceId,
            organizationId: session.activeOrganizationId,
            query,
            scopedDb,
          }),
      ),
    );

    return response;
  },
);

export default exportLedes;
