import { INVOICE_LINE_COLUMNS } from "@/api/handlers/invoices/invoice-lines";

/** The line items an invoice detail read loads with the invoice row. */
export const INVOICE_DETAIL_RELATIONS = {
  lines: {
    columns: INVOICE_LINE_COLUMNS,
    orderBy: { position: "asc", id: "asc" },
  },
  timeEntries: {
    columns: {
      id: true,
      workItemId: true,
      dateWorked: true,
      billedMinutes: true,
      rateAtEntry: true,
      currency: true,
      narrative: true,
      invoiceNarrative: true,
      noCharge: true,
      status: true,
    },
    with: { workItem: { columns: { id: true, name: true } } },
  },
  expenses: {
    columns: {
      id: true,
      matterId: true,
      dateIncurred: true,
      amount: true,
      currency: true,
      category: true,
      description: true,
      invoiceDescription: true,
      billable: true,
      markup: true,
    },
    with: { matter: { columns: { id: true, name: true } } },
  },
} as const;
