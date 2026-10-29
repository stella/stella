import { panic } from "better-result";
import { asc, sql } from "drizzle-orm";
import type { Column } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  expenses,
  invoiceLines,
  invoices,
  timeEntries,
  workspaces,
} from "@/api/db/schema";
import {
  parseInvoiceLinkExpensesRow,
  parseInvoiceLinkInvoiceRow,
  parseInvoiceLinkLinesRow,
  parseInvoiceLinkMattersRow,
  parseInvoiceLinkOriginalRow,
  parseInvoiceLinkSellerRow,
  parseInvoiceLinkTimeRow,
  readInvoiceLinkSettlement,
} from "@/api/handlers/invoice-links/function-rows";
import type { InvoiceLinkCaller } from "@/api/handlers/invoice-links/link-access";
import {
  INVOICE_DOCUMENT_PROJECTION,
  INVOICE_SELLER_PROJECTION,
} from "@/api/lib/billing/invoice-detail";
import type { INVOICE_LINE_COLUMNS } from "@/api/lib/billing/invoice-lines";
import { readInvoiceLinkScope } from "@/api/lib/billing/invoice-links";
import { invoicePaymentAmounts } from "@/api/lib/billing/invoice-payments";
import { invoiceSettledOn } from "@/api/lib/billing/invoice-settlement-date";
import { readBounded } from "@/api/lib/db/read-bounded";
import { LIMITS } from "@/api/lib/limits";
import { readOrganizationTimeZone } from "@/api/lib/organization-time-zone";

/** SQL function rows keep the owning column's decoder without claiming a table join. */
const functionColumn = (column: Column) =>
  sql`${sql.identifier(column.name)}`.mapWith(column);

export const INVOICE_LINK_DOCUMENT_PROJECTION = Object.fromEntries(
  Object.entries(INVOICE_DOCUMENT_PROJECTION).map(
    ([key, column]) => [key, functionColumn(column)] as const,
  ),
);

/** Each projection function rechecks the live hash and reads only its invoice's document fields. */
export const loadLinkedInvoiceData = async (
  tx: Transaction,
  caller: InvoiceLinkCaller,
) => {
  const send = await readInvoiceLinkScope(tx, caller.tokenHash);
  const invoiceRows = await tx
    .select(INVOICE_LINK_DOCUMENT_PROJECTION)
    .from(sql`public.invoice_link_invoice(${caller.tokenHash}) AS invoices`);
  const invoice = invoiceRows.map(parseInvoiceLinkInvoiceRow).at(0);
  if (!send || !invoice) {
    return null;
  }
  const sellerRows = await tx
    .select(
      Object.fromEntries(
        Object.entries(INVOICE_SELLER_PROJECTION).map(
          ([key, column]) => [key, functionColumn(column)] as const,
        ),
      ),
    )
    .from(
      sql`public.invoice_link_seller(${caller.tokenHash}) AS seller_profiles`,
    );
  const seller = sellerRows.map(parseInvoiceLinkSellerRow).at(0);
  const lineRead = await readBounded(
    tx
      .select({
        id: functionColumn(invoiceLines.id),
        workspaceId: functionColumn(invoiceLines.workspaceId),
        position: functionColumn(invoiceLines.position),
        recordedDescription: functionColumn(invoiceLines.recordedDescription),
        recordedQuantity: functionColumn(invoiceLines.recordedQuantity),
        recordedUnit: functionColumn(invoiceLines.recordedUnit),
        recordedUnitPrice: functionColumn(invoiceLines.recordedUnitPrice),
        recordedNetAmount: functionColumn(invoiceLines.recordedNetAmount),
        description: functionColumn(invoiceLines.description),
        quantity: functionColumn(invoiceLines.quantity),
        unit: functionColumn(invoiceLines.unit),
        unitPrice: functionColumn(invoiceLines.unitPrice),
        vatRateBps: functionColumn(invoiceLines.vatRateBps),
        vatTreatment: functionColumn(invoiceLines.vatTreatment),
        exemptionReason: functionColumn(invoiceLines.exemptionReason),
        netAmount: functionColumn(invoiceLines.netAmount),
        vatAmount: functionColumn(invoiceLines.vatAmount),
        grossAmount: functionColumn(invoiceLines.grossAmount),
        source: functionColumn(invoiceLines.source),
        billingPurpose: functionColumn(invoiceLines.billingPurpose),
        timeEntryId: functionColumn(invoiceLines.timeEntryId),
        expenseId: functionColumn(invoiceLines.expenseId),
        releasedAt: functionColumn(invoiceLines.releasedAt),
      } satisfies Record<keyof typeof INVOICE_LINE_COLUMNS, unknown>)
      .from(
        sql`public.invoice_link_lines(${caller.tokenHash}) AS invoice_lines`,
      )
      .orderBy(
        asc(functionColumn(invoiceLines.position)),
        asc(functionColumn(invoiceLines.id)),
      ),
    LIMITS.invoiceLinesPerInvoice,
  );
  const timeRead = await readBounded(
    tx
      .select({
        id: functionColumn(timeEntries.id),
        workspaceId: functionColumn(timeEntries.workspaceId),
        dateWorked: functionColumn(timeEntries.dateWorked),
        billedMinutes: functionColumn(timeEntries.billedMinutes),
        rateAtEntry: functionColumn(timeEntries.rateAtEntry),
        documentDescription: sql`time_entries.document_description`,
        noCharge: functionColumn(timeEntries.noCharge),
        invoiceAttachment: functionColumn(timeEntries.invoiceAttachment),
      })
      .from(sql`public.invoice_link_time(${caller.tokenHash}) AS time_entries`)
      .orderBy(
        asc(functionColumn(timeEntries.dateWorked)),
        asc(functionColumn(timeEntries.id)),
      ),
    LIMITS.invoiceSourceItemsPerKind,
  );
  const expenseRead = await readBounded(
    tx
      .select({
        id: functionColumn(expenses.id),
        workspaceId: functionColumn(expenses.workspaceId),
        dateIncurred: functionColumn(expenses.dateIncurred),
        amount: functionColumn(expenses.amount),
        currency: functionColumn(expenses.currency),
        category: functionColumn(expenses.category),
        description: functionColumn(expenses.description),
        invoiceDescription: functionColumn(expenses.invoiceDescription),
        billable: functionColumn(expenses.billable),
        markup: functionColumn(expenses.markup),
      })
      .from(sql`public.invoice_link_expenses(${caller.tokenHash}) AS expenses`)
      .orderBy(
        asc(functionColumn(expenses.dateIncurred)),
        asc(functionColumn(expenses.id)),
      ),
    LIMITS.invoiceSourceItemsPerKind,
  );
  if (
    lineRead.type === "overflow" ||
    timeRead.type === "overflow" ||
    expenseRead.type === "overflow"
  ) {
    panic("Invoice document exceeds its bounded line or source limit");
  }
  const lines = lineRead.rows.map(parseInvoiceLinkLinesRow);
  const time = timeRead.rows
    .map(parseInvoiceLinkTimeRow)
    .map(({ documentDescription, ...entry }) => ({
      ...entry,
      invoiceNarrative: documentDescription,
    }));
  const linkedExpenses = expenseRead.rows.map(parseInvoiceLinkExpensesRow);
  const mattersRows = await tx
    .select({
      id: functionColumn(workspaces.id),
      name: functionColumn(workspaces.name),
      reference: functionColumn(workspaces.reference),
      color: functionColumn(workspaces.color),
    })
    .from(sql`public.invoice_link_matters(${caller.tokenHash}) AS workspaces`);
  const matters = mattersRows.map(parseInvoiceLinkMattersRow);
  const originalRows = await tx
    .select({
      id: functionColumn(invoices.id),
      invoiceNumber: functionColumn(invoices.invoiceNumber),
      invoiceDate: functionColumn(invoices.invoiceDate),
    })
    .from(sql`public.invoice_link_original(${caller.tokenHash}) AS invoices`);
  const original = originalRows.map(parseInvoiceLinkOriginalRow);
  const settlement = await readInvoiceLinkSettlement(tx, caller.tokenHash);
  const stillLive = await readInvoiceLinkScope(tx, caller.tokenHash);
  if (!stillLive) {
    return null;
  }
  if (settlement === undefined) {
    return panic("Live invoice has no payment summary projection");
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
    timeEntries: time,
    expenses: linkedExpenses.map((expense) => ({
      ...expense,
      matterId: null,
      matterReference: null,
      matter: null,
    })),
  };
  const timeZone = await readOrganizationTimeZone(tx, caller.organizationId);
  return {
    outstandingAmount: invoicePaymentAmounts({
      totalAmount: invoice.totalAmount,
      paidAmount: settlement.paidAmount,
    }).outstandingAmount,
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
      invoices: [
        {
          ...linkedInvoice,
          paidDate: invoiceSettledOn({
            status: invoice.status,
            paidAt: invoice.paidAt,
            latestPaidOn: settlement.latestPaidOn,
            timeZone,
          }),
        },
      ],
      sellers: new Map(seller ? [[seller.id, seller]] : []),
      originals: new Map(
        original.map((row) => [
          row.id,
          { number: row.invoiceNumber, issueDate: row.invoiceDate },
        ]),
      ),
      timeZone,
    },
  };
};
