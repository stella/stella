import { panic } from "better-result";
import { asc, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  expenses,
  invoiceLines,
  invoices,
  invoiceSends,
  timeEntries,
  workspaces,
} from "@/api/db/schema";
import type { InvoiceLinkCaller } from "@/api/handlers/invoice-links/link-access";
import {
  INVOICE_DOCUMENT_PROJECTION,
  INVOICE_SELLER_PROJECTION,
} from "@/api/handlers/invoices/invoice-detail";
import type { INVOICE_LINE_COLUMNS } from "@/api/lib/billing/invoice-lines";
import {
  selectTimekeeperNames,
  timekeeperIdsOf,
} from "@/api/lib/billing/timekeeper-names";
import { readBounded } from "@/api/lib/db/read-bounded";
import { LIMITS } from "@/api/lib/limits";
import { readOrganizationTimeZone } from "@/api/lib/organization-time-zone";

/** Each projection function rechecks the live hash and reads only its invoice's document fields. */
export const loadLinkedInvoiceData = async (
  tx: Transaction,
  caller: InvoiceLinkCaller,
) => {
  const [send] = await tx
    .select({ expiresAt: invoiceSends.expiresAt })
    .from(sql`public.invoice_link_scope(${caller.tokenHash}) AS invoice_sends`);
  const [invoice] = await tx
    .select(INVOICE_DOCUMENT_PROJECTION)
    .from(sql`public.invoice_link_invoice(${caller.tokenHash}) AS invoices`);
  if (!send || !invoice) {
    return null;
  }
  const [seller] = await tx
    .select(INVOICE_SELLER_PROJECTION)
    .from(
      sql`public.invoice_link_seller(${caller.tokenHash}) AS seller_profiles`,
    );
  const lineRead = await readBounded(
    tx
      .select({
        id: invoiceLines.id,
        workspaceId: invoiceLines.workspaceId,
        position: invoiceLines.position,
        recordedDescription: invoiceLines.recordedDescription,
        recordedQuantity: invoiceLines.recordedQuantity,
        recordedUnit: invoiceLines.recordedUnit,
        recordedUnitPrice: invoiceLines.recordedUnitPrice,
        recordedNetAmount: invoiceLines.recordedNetAmount,
        description: invoiceLines.description,
        quantity: invoiceLines.quantity,
        unit: invoiceLines.unit,
        unitPrice: invoiceLines.unitPrice,
        vatRateBps: invoiceLines.vatRateBps,
        vatTreatment: invoiceLines.vatTreatment,
        exemptionReason: invoiceLines.exemptionReason,
        netAmount: invoiceLines.netAmount,
        vatAmount: invoiceLines.vatAmount,
        grossAmount: invoiceLines.grossAmount,
        source: invoiceLines.source,
        billingPurpose: invoiceLines.billingPurpose,
        timeEntryId: invoiceLines.timeEntryId,
        expenseId: invoiceLines.expenseId,
        releasedAt: invoiceLines.releasedAt,
      } satisfies Record<keyof typeof INVOICE_LINE_COLUMNS, unknown>)
      .from(
        sql`public.invoice_link_lines(${caller.tokenHash}) AS invoice_lines`,
      )
      .orderBy(asc(invoiceLines.position), asc(invoiceLines.id)),
    LIMITS.invoiceLinesPerInvoice,
  );
  const timeRead = await readBounded(
    tx
      .select({
        id: timeEntries.id,
        workspaceId: timeEntries.workspaceId,
        dateWorked: timeEntries.dateWorked,
        billedMinutes: timeEntries.billedMinutes,
        rateAtEntry: timeEntries.rateAtEntry,
        currency: timeEntries.currency,
        narrative: timeEntries.narrative,
        invoiceNarrative: timeEntries.invoiceNarrative,
        noCharge: timeEntries.noCharge,
        status: timeEntries.status,
        invoiceAttachment: timeEntries.invoiceAttachment,
        userId: timeEntries.userId,
        taskCode: timeEntries.taskCode,
        activityCode: timeEntries.activityCode,
      })
      .from(sql`public.invoice_link_time(${caller.tokenHash}) AS time_entries`)
      .orderBy(asc(timeEntries.dateWorked), asc(timeEntries.id)),
    LIMITS.invoiceSourceItemsPerKind,
  );
  const expenseRead = await readBounded(
    tx
      .select({
        id: expenses.id,
        workspaceId: expenses.workspaceId,
        dateIncurred: expenses.dateIncurred,
        amount: expenses.amount,
        currency: expenses.currency,
        category: expenses.category,
        description: expenses.description,
        invoiceDescription: expenses.invoiceDescription,
        billable: expenses.billable,
        markup: expenses.markup,
      })
      .from(sql`public.invoice_link_expenses(${caller.tokenHash}) AS expenses`)
      .orderBy(asc(expenses.dateIncurred), asc(expenses.id)),
    LIMITS.invoiceSourceItemsPerKind,
  );
  if (
    lineRead.type === "overflow" ||
    timeRead.type === "overflow" ||
    expenseRead.type === "overflow"
  ) {
    panic("Invoice document exceeds its bounded line or source limit");
  }
  const lines = lineRead.rows;
  const time = timeRead.rows;
  const linkedExpenses = expenseRead.rows;
  const matters = await tx
    .select({
      id: workspaces.id,
      name: workspaces.name,
      reference: workspaces.reference,
      color: workspaces.color,
    })
    .from(sql`public.invoice_link_matters(${caller.tokenHash}) AS workspaces`);
  const original = await tx
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
    })
    .from(sql`public.invoice_link_original(${caller.tokenHash}) AS invoices`);
  const [stillLive] = await tx
    .select({ expiresAt: invoiceSends.expiresAt })
    .from(sql`public.invoice_link_scope(${caller.tokenHash}) AS invoice_sends`);
  if (!stillLive) {
    return null;
  }
  const matterMap = new Map(matters.map((matter) => [matter.id, matter]));
  const workspaceId =
    caller.workspaceIds.at(0) ?? panic("Live invoice link has no matter");
  const matter =
    matterMap.get(workspaceId) ?? panic("Linked invoice matter disappeared");
  const linkedInvoice = {
    ...invoice,
    lines: lines.map((line) => ({
      ...line,
      workspace:
        matterMap.get(line.workspaceId) ??
        panic("Linked line matter disappeared"),
    })),
    timeEntries: time.map((entry) => ({
      ...entry,
      workItemId: null,
      workItemReference: null,
      workItem: null,
    })),
    expenses: linkedExpenses.map((expense) => ({
      ...expense,
      matterId: null,
      matterReference: null,
      matter: null,
    })),
  };
  const timekeepers =
    time.length === 0
      ? []
      : await selectTimekeeperNames(tx, {
          organizationId: caller.organizationId,
          userIds: timekeeperIdsOf(time),
        });
  return {
    send,
    document: {
      invoice: linkedInvoice,
      seller: seller ?? null,
      originalNumber: original.at(0)?.invoiceNumber ?? null,
      workspaceId,
      matterName: matter.name,
    },
    exportData: {
      matter,
      matters: matterMap,
      invoices: [linkedInvoice],
      sellers: new Map(seller ? [[seller.id, seller]] : []),
      originals: new Map(
        original.map((row) => [
          row.id,
          { number: row.invoiceNumber, issueDate: row.invoiceDate },
        ]),
      ),
      timekeepers: new Map(timekeepers.map((user) => [user.id, user.name])),
      timeZone: await readOrganizationTimeZone(tx, caller.organizationId),
    },
  };
};
