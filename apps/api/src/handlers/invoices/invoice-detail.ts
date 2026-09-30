import type { invoices } from "@/api/db/schema";
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

// Summary rows omit tenant ownership and document composition; detail mode
// returns buyer, seller, tax, notes, and calculated line/VAT totals instead.
export const INVOICE_SUMMARY_OMITTED_COLUMNS = [
  "organizationId",
  "workspaceId",
  "finalizedAt",
  "taxableSupplyDate",
  "sellerProfileId",
  "buyerName",
  "buyerRegistrationId",
  "buyerVatId",
  "buyerAddressLine1",
  "buyerAddressLine2",
  "buyerCity",
  "buyerPostalCode",
  "buyerCountry",
  "notes",
  "netAmount",
  "vatAmount",
] as const satisfies readonly (keyof typeof invoices.$inferSelect)[];
