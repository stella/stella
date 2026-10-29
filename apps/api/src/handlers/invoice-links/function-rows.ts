import { createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import {
  expenses,
  invoiceLines,
  invoices,
  sellerProfiles,
  timeEntries,
  workspaces,
} from "@/api/db/schema";
import type {
  INVOICE_DOCUMENT_COLUMNS,
  INVOICE_SELLER_COLUMNS,
} from "@/api/handlers/invoices/invoice-detail";
import type { INVOICE_LINE_COLUMNS } from "@/api/lib/billing/invoice-lines";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { cents } from "@/api/lib/money";
import {
  brandPersistedContactId,
  brandPersistedExpenseId,
  brandPersistedInvoiceId,
  brandPersistedOrganizationId,
  brandPersistedSellerProfileId,
  brandPersistedTimeEntryId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
// Drizzle decodes dates and bigint amounts before these function-result parsers
// validate the selected fields. Refinements retain their domain brands.
const invoicesRowSchema = createSelectSchema(invoices, {
  id: (schema) => v.pipe(schema, v.transform(brandPersistedInvoiceId)),
  organizationId: (schema) =>
    v.pipe(schema, v.transform(brandPersistedOrganizationId)),
  workspaceId: (schema) =>
    v.pipe(schema, v.transform(brandPersistedWorkspaceId)),
  clientId: (schema) => v.pipe(schema, v.transform(brandPersistedContactId)),
  sellerProfileId: (schema) =>
    v.pipe(schema, v.transform(brandPersistedSellerProfileId)),
  originalInvoiceId: (schema) =>
    v.pipe(schema, v.transform(brandPersistedInvoiceId)),
  netAmount: (schema) => v.pipe(schema, v.transform(cents)),
  totalAmount: (schema) => v.pipe(schema, v.transform(cents)),
});

const sellerProfilesRowSchema = createSelectSchema(sellerProfiles, {
  id: (schema) => v.pipe(schema, v.transform(brandPersistedSellerProfileId)),
});

const invoiceLinesRowSchema = createSelectSchema(invoiceLines, {
  id: resourceIdSchema("invoiceLine"),
  workspaceId: (schema) =>
    v.pipe(schema, v.transform(brandPersistedWorkspaceId)),
  recordedUnitPrice: (schema) => v.pipe(schema, v.transform(cents)),
  recordedNetAmount: (schema) => v.pipe(schema, v.transform(cents)),
  unitPrice: (schema) => v.pipe(schema, v.transform(cents)),
  netAmount: (schema) => v.pipe(schema, v.transform(cents)),
  vatAmount: (schema) => v.pipe(schema, v.transform(cents)),
  grossAmount: (schema) => v.pipe(schema, v.transform(cents)),
  timeEntryId: (schema) =>
    v.pipe(schema, v.transform(brandPersistedTimeEntryId)),
  expenseId: (schema) => v.pipe(schema, v.transform(brandPersistedExpenseId)),
});

const timeEntriesRowSchema = createSelectSchema(timeEntries, {
  id: (schema) => v.pipe(schema, v.transform(brandPersistedTimeEntryId)),
  workspaceId: (schema) =>
    v.pipe(schema, v.transform(brandPersistedWorkspaceId)),
  rateAtEntry: (schema) => v.pipe(schema, v.transform(cents)),
});

const expensesRowSchema = createSelectSchema(expenses, {
  id: (schema) => v.pipe(schema, v.transform(brandPersistedExpenseId)),
  workspaceId: (schema) =>
    v.pipe(schema, v.transform(brandPersistedWorkspaceId)),
  amount: (schema) => v.pipe(schema, v.transform(cents)),
});

const workspacesRowSchema = createSelectSchema(workspaces, {
  id: (schema) => v.pipe(schema, v.transform(brandPersistedWorkspaceId)),
});

const invoiceFunctionRowSchema = v.pick(invoicesRowSchema, [
  "id",
  "organizationId",
  "workspaceId",
  "clientId",
  "sellerProfileId",
  "originalInvoiceId",
  "status",
  "documentType",
  "invoiceNumber",
  "invoiceDate",
  "dueDate",
  "taxableSupplyDate",
  "currency",
  "language",
  "reference",
  "notes",
  "vatExchangeRate",
  "vatExchangeRateSource",
  "vatExchangeRateDate",
  "vatExchangeRateReference",
  "vatExchangeRateTaxPoint",
  "buyerName",
  "buyerRegistrationId",
  "buyerTaxId",
  "buyerVatId",
  "buyerAddressLine1",
  "buyerAddressLine2",
  "buyerCity",
  "buyerPostalCode",
  "buyerCountry",
  "netAmount",
  "totalAmount",
  "paidAt",
]);
true satisfies Exclude<
  keyof typeof INVOICE_DOCUMENT_COLUMNS,
  keyof v.InferOutput<typeof invoiceFunctionRowSchema>
> extends never
  ? true
  : never;
export const parseInvoiceLinkInvoiceRow = (row: unknown) =>
  v.parse(invoiceFunctionRowSchema, row);

const sellerFunctionRowSchema = v.pick(sellerProfilesRowSchema, [
  "id",
  "legalName",
  "registrationId",
  "taxId",
  "vatId",
  "registerEntry",
  "barRegistration",
  "vatPayer",
  "addressLine1",
  "addressLine2",
  "city",
  "postalCode",
  "country",
  "iban",
  "bic",
  "accountNumber",
  "defaultCurrency",
  "footerNotes",
]);
true satisfies Exclude<
  keyof typeof INVOICE_SELLER_COLUMNS,
  keyof v.InferOutput<typeof sellerFunctionRowSchema>
> extends never
  ? true
  : never;
export const parseInvoiceLinkSellerRow = (row: unknown) =>
  v.parse(sellerFunctionRowSchema, row);

const linesFunctionRowSchema = v.pick(invoiceLinesRowSchema, [
  "id",
  "workspaceId",
  "position",
  "recordedDescription",
  "recordedQuantity",
  "recordedUnit",
  "recordedUnitPrice",
  "recordedNetAmount",
  "description",
  "quantity",
  "unit",
  "unitPrice",
  "vatRateBps",
  "vatTreatment",
  "exemptionReason",
  "netAmount",
  "vatAmount",
  "grossAmount",
  "source",
  "billingPurpose",
  "timeEntryId",
  "expenseId",
  "releasedAt",
]);
true satisfies Exclude<
  keyof typeof INVOICE_LINE_COLUMNS,
  keyof v.InferOutput<typeof linesFunctionRowSchema>
> extends never
  ? true
  : never;
export const parseInvoiceLinkLinesRow = (row: unknown) =>
  v.parse(linesFunctionRowSchema, row);

const timeFunctionRowSchema = v.pick(timeEntriesRowSchema, [
  "id",
  "workspaceId",
  "dateWorked",
  "billedMinutes",
  "rateAtEntry",
  "currency",
  "narrative",
  "invoiceNarrative",
  "noCharge",
  "status",
  "invoiceAttachment",
  "userId",
  "taskCode",
  "activityCode",
]);
export const parseInvoiceLinkTimeRow = (row: unknown) =>
  v.parse(timeFunctionRowSchema, row);

const expensesFunctionRowSchema = v.pick(expensesRowSchema, [
  "id",
  "workspaceId",
  "dateIncurred",
  "amount",
  "currency",
  "category",
  "description",
  "invoiceDescription",
  "billable",
  "markup",
]);
export const parseInvoiceLinkExpensesRow = (row: unknown) =>
  v.parse(expensesFunctionRowSchema, row);

const mattersFunctionRowSchema = v.pick(workspacesRowSchema, [
  "id",
  "name",
  "reference",
  "color",
]);
export const parseInvoiceLinkMattersRow = (row: unknown) =>
  v.parse(mattersFunctionRowSchema, row);

const originalFunctionRowSchema = v.pick(invoicesRowSchema, [
  "id",
  "invoiceNumber",
  "invoiceDate",
]);
export const parseInvoiceLinkOriginalRow = (row: unknown) =>
  v.parse(originalFunctionRowSchema, row);

const settlementFunctionRowSchema = v.object({
  latestPaidOn: v.nullable(v.pipe(v.string(), v.isoDate())),
});
export const parseInvoiceLinkSettlementRow = (row: unknown) =>
  v.parse(settlementFunctionRowSchema, row);
