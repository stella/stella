import type { BuildQueryResult } from "drizzle-orm";
import type * as v from "valibot";

import { cents } from "@stll/money";

import type { databaseRelations } from "@/api/db/database-relations";
import type { INVOICE_DETAIL_RELATIONS } from "@/api/handlers/invoices/invoice-detail";
import { toSafeId } from "@/api/lib/branded-types";
import type { LIST_INVOICES_LIST_PROJECTION } from "@/api/lib/chat/projections";

// Derive the loaded row from the production relation selection, so a new
// required relation cannot disappear behind a permissive database double.
type InvoiceDetailRow = BuildQueryResult<
  typeof databaseRelations,
  (typeof databaseRelations)["invoices"],
  { with: typeof INVOICE_DETAIL_RELATIONS }
>;

type InvoiceDetailFixtureOptions = Partial<InvoiceDetailRow> &
  Pick<InvoiceDetailRow, "id" | "workspaceId">;

export const invoiceDetailRowFixture = (options: InvoiceDetailFixtureOptions) =>
  ({
    organizationId: toSafeId<"organization">("org_1"),
    clientId: null,
    invoiceNumber: null,
    documentType: "invoice",
    originalInvoiceId: null,
    reference: null,
    status: "draft",
    invoiceDate: "2026-01-01",
    dueDate: null,
    currency: "EUR",
    totalAmount: cents(0),
    language: "en",
    billingMode: "hourly",
    flatFeeAmount: null,
    finalizedAt: null,
    sentAt: null,
    vatExchangeRate: null,
    vatExchangeRateSource: null,
    vatExchangeRateDate: null,
    vatExchangeRateReference: null,
    vatExchangeRateTaxPoint: null,
    netAmount: null,
    vatAmount: null,
    notes: null,
    taxableSupplyDate: null,
    sellerProfileId: null,
    buyerName: null,
    buyerRegistrationId: null,
    buyerTaxId: null,
    buyerVatId: null,
    buyerAddressLine1: null,
    buyerAddressLine2: null,
    buyerCity: null,
    buyerPostalCode: null,
    buyerCountry: null,
    paidAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    lines: [],
    payments: [],
    timeEntries: [],
    expenses: [],
    ...options,
  }) satisfies InvoiceDetailRow;

// The list query supplies the paid sum; the mapper computes outstanding and
// replaces its private cursor timestamp with the opaque page cursor.
type InvoiceListRow = Omit<
  v.InferInput<typeof LIST_INVOICES_LIST_PROJECTION>["invoices"][number],
  "outstandingAmount"
> & { createdAtCursor: Date };

type InvoiceListFixtureOptions = Partial<InvoiceListRow> &
  Pick<InvoiceListRow, "id">;

export const invoiceListRowFixture = (options: InvoiceListFixtureOptions) =>
  ({
    clientId: null,
    matterShare: 0,
    invoiceNumber: null,
    documentType: "invoice",
    originalInvoiceId: null,
    reference: null,
    status: "draft",
    invoiceDate: "2026-01-01",
    dueDate: null,
    currency: "EUR",
    totalAmount: 0,
    paidAmount: 0,
    createdAtCursor: new Date("2026-01-01T00:00:00.000Z"),
    ...options,
  }) satisfies InvoiceListRow;
