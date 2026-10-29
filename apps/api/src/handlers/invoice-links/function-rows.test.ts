import { describe, expect, test } from "bun:test";
import { ValiError } from "valibot";

import {
  EXPENSE_CATEGORIES,
  INVOICE_LINE_SOURCES,
  TIME_ENTRY_STATUSES,
} from "@stll/api-contract";
import { VAT_TREATMENTS } from "@stll/invoicing";

import {
  INVOICE_ATTACHMENT,
  INVOICE_BILLING_PURPOSE,
  INVOICE_STATUS,
} from "@/api/db/schema";
import {
  parseInvoiceLinkExpensesRow,
  parseInvoiceLinkInvoiceRow,
  parseInvoiceLinkLinesRow,
  parseInvoiceLinkMattersRow,
  parseInvoiceLinkOriginalRow,
  parseInvoiceLinkSellerRow,
  parseInvoiceLinkSettlementRow,
  parseInvoiceLinkTimeRow,
} from "@/api/handlers/invoice-links/function-rows";

const invoiceId = "0190c3a1-7a2b-7c31-8ea0-012345678901";
const organizationId = "0190c3a1-7a2b-7c31-8ea0-012345678902";
const workspaceId = "0190c3a1-7a2b-7c31-8ea0-012345678903";
const sellerProfileId = "0190c3a1-7a2b-7c31-8ea0-012345678904";
const lineId = "0190c3a1-7a2b-7c31-8ea0-012345678905";
const timeEntryId = "0190c3a1-7a2b-7c31-8ea0-012345678906";
const expenseId = "0190c3a1-7a2b-7c31-8ea0-012345678907";
const invoiceDate = "2025-01-15";
const timestamp = new Date("2025-01-15T12:00:00.000Z");

const invoiceRow = {
  id: invoiceId,
  organizationId,
  workspaceId,
  clientId: null,
  sellerProfileId,
  originalInvoiceId: null,
  status: INVOICE_STATUS.PAID,
  documentType: "invoice",
  invoiceNumber: "2025-001",
  invoiceDate,
  dueDate: null,
  taxableSupplyDate: null,
  currency: "EUR",
  language: "en",
  reference: null,
  notes: null,
  vatExchangeRate: null,
  vatExchangeRateSource: null,
  vatExchangeRateDate: null,
  vatExchangeRateReference: null,
  vatExchangeRateTaxPoint: null,
  buyerName: null,
  buyerRegistrationId: null,
  buyerTaxId: null,
  buyerVatId: null,
  buyerAddressLine1: null,
  buyerAddressLine2: null,
  buyerCity: null,
  buyerPostalCode: null,
  buyerCountry: null,
  netAmount: null,
  totalAmount: 12_345,
  paidAt: timestamp,
};

const sellerRow = {
  id: sellerProfileId,
  legalName: "Example Counsel s.r.o.",
  registrationId: null,
  taxId: null,
  vatId: null,
  registerEntry: null,
  barRegistration: null,
  vatPayer: false,
  addressLine1: null,
  addressLine2: null,
  city: null,
  postalCode: null,
  country: null,
  iban: null,
  bic: null,
  accountNumber: null,
  defaultCurrency: "EUR",
  footerNotes: null,
};

const lineRow = {
  id: lineId,
  workspaceId,
  position: 0,
  recordedDescription: null,
  recordedQuantity: null,
  recordedUnit: null,
  recordedUnitPrice: null,
  recordedNetAmount: null,
  description: "Legal services",
  quantity: "1.0000",
  unit: "hour",
  unitPrice: 12_345,
  vatRateBps: 0,
  vatTreatment: VAT_TREATMENTS[0],
  exemptionReason: null,
  netAmount: 12_345,
  vatAmount: 0,
  grossAmount: 12_345,
  source: INVOICE_LINE_SOURCES[0],
  billingPurpose: INVOICE_BILLING_PURPOSE.ORDINARY,
  timeEntryId: null,
  expenseId: null,
  releasedAt: timestamp,
};

const timeRow = {
  id: timeEntryId,
  workspaceId,
  dateWorked: invoiceDate,
  billedMinutes: 60,
  rateAtEntry: 12_345,
  currency: "EUR",
  narrative: "Legal services",
  invoiceNarrative: null,
  noCharge: false,
  status: TIME_ENTRY_STATUSES[0],
  invoiceAttachment: INVOICE_ATTACHMENT.CHARGED,
  userId: null,
  taskCode: null,
  activityCode: null,
};

const expenseRow = {
  id: expenseId,
  workspaceId,
  dateIncurred: invoiceDate,
  amount: 12_345,
  currency: "EUR",
  category: EXPENSE_CATEGORIES[0],
  description: "Court fee",
  invoiceDescription: null,
  billable: true,
  markup: 0,
};

const matterRow = {
  id: workspaceId,
  name: "Example matter",
  reference: "MAT-001",
  color: null,
};

const originalRow = {
  id: invoiceId,
  invoiceNumber: "2024-099",
  invoiceDate,
};

const settlementRow = { latestPaidOn: invoiceDate };

const parsedRows: {
  name: string;
  parse: (row: unknown) => unknown;
  row: Record<string, unknown>;
}[] = [
  { name: "invoice", parse: parseInvoiceLinkInvoiceRow, row: invoiceRow },
  { name: "seller", parse: parseInvoiceLinkSellerRow, row: sellerRow },
  { name: "line", parse: parseInvoiceLinkLinesRow, row: lineRow },
  { name: "time entry", parse: parseInvoiceLinkTimeRow, row: timeRow },
  { name: "expense", parse: parseInvoiceLinkExpensesRow, row: expenseRow },
  { name: "matter", parse: parseInvoiceLinkMattersRow, row: matterRow },
  {
    name: "original invoice",
    parse: parseInvoiceLinkOriginalRow,
    row: originalRow,
  },
  {
    name: "settlement",
    parse: parseInvoiceLinkSettlementRow,
    row: settlementRow,
  },
];

describe("invoice link function rows", () => {
  for (const { name, parse, row } of parsedRows) {
    test(`${name} decoded rows preserve selected fields and strip extras`, () => {
      expect(parse(row)).toEqual(row);
      expect(parse({ ...row, internalOnly: "must not escape" })).toEqual(row);
    });

    test(`${name} rows reject an object in every selected field`, () => {
      for (const field of Object.keys(row)) {
        expect(() => parse({ ...row, [field]: {} })).toThrow(ValiError);
      }
    });

    if ("id" in row) {
      test(`${name} rows reject malformed resource IDs`, () => {
        expect(() => parse({ ...row, id: "not-a-uuid" })).toThrow(ValiError);
      });
    }
  }

  test("domain enums, nullable values, and money retain their boundaries", () => {
    expect(parseInvoiceLinkInvoiceRow(invoiceRow)).toMatchObject({
      clientId: null,
      totalAmount: 12_345,
      status: INVOICE_STATUS.PAID,
    });
    expect(() =>
      parseInvoiceLinkInvoiceRow({ ...invoiceRow, status: "unknown" }),
    ).toThrow(ValiError);
    expect(() =>
      parseInvoiceLinkInvoiceRow({ ...invoiceRow, documentType: "unknown" }),
    ).toThrow(ValiError);
    expect(() =>
      parseInvoiceLinkInvoiceRow({ ...invoiceRow, totalAmount: 1.5 }),
    ).toThrow(ValiError);

    expect(() =>
      parseInvoiceLinkLinesRow({ ...lineRow, vatTreatment: "unknown" }),
    ).toThrow(ValiError);
    expect(() =>
      parseInvoiceLinkLinesRow({ ...lineRow, grossAmount: 1.5 }),
    ).toThrow(ValiError);

    expect(() =>
      parseInvoiceLinkTimeRow({ ...timeRow, invoiceAttachment: "unknown" }),
    ).toThrow(ValiError);
    expect(() =>
      parseInvoiceLinkExpensesRow({
        ...expenseRow,
        category: "unknown",
      }),
    ).toThrow(ValiError);
    expect(() =>
      parseInvoiceLinkExpensesRow({ ...expenseRow, amount: 1.5 }),
    ).toThrow(ValiError);
  });
});
