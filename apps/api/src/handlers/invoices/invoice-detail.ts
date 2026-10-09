import { entityContextProjection } from "@/api/db/entity-feature-policies";
import { expenses, timeEntries } from "@/api/db/schema";
import { INVOICE_LINE_COLUMNS } from "@/api/handlers/invoices/invoice-lines";

const timeEntryContext = entityContextProjection(timeEntries.workItemId);
const expenseContext = entityContextProjection(expenses.matterId);

/** The line items an invoice detail read loads with the invoice row. */
export const INVOICE_DETAIL_RELATIONS = {
  lines: {
    columns: INVOICE_LINE_COLUMNS,
    orderBy: { position: "asc", id: "asc" },
  },
  timeEntries: {
    columns: {
      id: true,
      dateWorked: true,
      billedMinutes: true,
      rateAtEntry: true,
      currency: true,
      narrative: true,
      invoiceNarrative: true,
      noCharge: true,
      status: true,
      invoiceAttachment: true,
    },
    extras: {
      workItemId: (table: typeof timeEntries) =>
        timeEntryContext.id(table.workItemId),
      workItemReference: (table: typeof timeEntries) =>
        timeEntryContext.reference(table.workItemId),
    },
    with: { workItem: { columns: { id: true, name: true } } },
  },
  expenses: {
    columns: {
      id: true,
      dateIncurred: true,
      amount: true,
      currency: true,
      category: true,
      description: true,
      invoiceDescription: true,
      billable: true,
      markup: true,
    },
    extras: {
      matterId: (table: typeof expenses) => expenseContext.id(table.matterId),
      matterReference: (table: typeof expenses) =>
        expenseContext.reference(table.matterId),
    },
    with: { matter: { columns: { id: true, name: true } } },
  },
} as const;
