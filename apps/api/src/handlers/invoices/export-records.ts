import { Result } from "better-result";

import type {
  InvoiceExportLine,
  InvoiceExportRecord,
  InvoiceExportSeller,
  InvoiceLine,
  InvoiceParty,
  InvoiceTotals,
} from "@stll/invoicing";
import type { CentsAmount } from "@stll/money";
import { Temporal, todayFor } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { INVOICE_STATUS } from "@/api/db/schema";
import { INVOICE_DETAIL_RELATIONS } from "@/api/handlers/invoices/invoice-detail";
import { readInvoiceDocumentLines } from "@/api/handlers/invoices/invoice-lines";
import { selectTimekeeperNames } from "@/api/handlers/time-entries/timekeeper-names";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { readOrganizationTimeZone } from "@/api/lib/organization-time-zone";

/** Issued documents only: a draft has no number, a void one is not booked. */
const EXPORTABLE_STATUSES = [
  INVOICE_STATUS.FINALIZED,
  INVOICE_STATUS.SENT,
  INVOICE_STATUS.PAID,
] as const;
type ExportableStatus = (typeof EXPORTABLE_STATUSES)[number];
const isExportable = (status: string): status is ExportableStatus =>
  (EXPORTABLE_STATUSES as readonly string[]).includes(status);

/** UTBMS expense codes for stella's expense categories. */
const UTBMS_EXPENSE_CODE = new Map<string, string>([
  ["filing_fee", "E112"],
  ["expert_witness", "E119"],
  ["travel", "E110"],
  ["printing", "E102"],
  ["courier", "E107"],
]);

const EXPORT_RELATIONS = {
  ...INVOICE_DETAIL_RELATIONS,
  timeEntries: {
    ...INVOICE_DETAIL_RELATIONS.timeEntries,
    columns: {
      ...INVOICE_DETAIL_RELATIONS.timeEntries.columns,
      userId: true,
      taskCode: true,
      activityCode: true,
    },
  },
} as const;

const PARTY_FIELDS = [
  "registrationNumber",
  "vatId",
  "addressLine1",
  "addressLine2",
  "city",
  "postalCode",
  "country",
] as const;

type StoredParty = Record<(typeof PARTY_FIELDS)[number], string | null>;

const presentText = (value: string | null): value is string =>
  value !== null && value.trim() !== "";

/** A party as an export carries it: blank stored fields are left out. */
const partyOf = (name: string, stored: StoredParty): InvoiceParty => ({
  name,
  ...Object.fromEntries(
    PARTY_FIELDS.flatMap((field) => {
      const value = stored[field];
      return presentText(value) ? [[field, value]] : [];
    }),
  ),
});

type ExportScope = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  invoiceIds: readonly SafeId<"invoice">[] | undefined;
};

/** Everything an invoice export reads, in the caller's transaction. */
export const loadInvoiceExport = async (
  tx: Transaction,
  { organizationId, workspaceId, invoiceIds }: ExportScope,
) => {
  const matter = await tx.query.workspaces.findFirst({
    where: { id: { eq: workspaceId }, organizationId: { eq: organizationId } },
    columns: { id: true, name: true, reference: true },
  });
  const invoices = await tx.query.invoices.findMany({
    where: {
      workspaceId: { eq: workspaceId },
      organizationId: { eq: organizationId },
      status: { in: [...EXPORTABLE_STATUSES] },
      ...(invoiceIds ? { id: { in: [...invoiceIds] } } : {}),
    },
    orderBy: { invoiceDate: "asc", invoiceNumber: "asc" },
    limit: LIMITS.exportRowLimit,
    with: EXPORT_RELATIONS,
  });
  const sellerIds = [
    ...new Set(invoices.flatMap((invoice) => invoice.sellerProfileId ?? [])),
  ];
  const sellers =
    sellerIds.length === 0
      ? []
      : await tx.query.sellerProfiles.findMany({
          where: {
            id: { in: sellerIds },
            organizationId: { eq: organizationId },
          },
          limit: sellerIds.length,
        });
  const originalIds = [
    ...new Set(invoices.flatMap((invoice) => invoice.originalInvoiceId ?? [])),
  ];
  const originals =
    originalIds.length === 0
      ? []
      : await tx.query.invoices.findMany({
          where: {
            id: { in: originalIds },
            workspaceId: { eq: workspaceId },
            organizationId: { eq: organizationId },
          },
          columns: { id: true, invoiceNumber: true },
          limit: originalIds.length,
        });
  const userIds = new Set(
    invoices.flatMap((invoice) =>
      invoice.timeEntries.flatMap((entry) => entry.userId ?? []),
    ),
  );
  const timekeepers =
    userIds.size === 0
      ? []
      : await selectTimekeeperNames(tx, { organizationId, userIds });
  return {
    matter,
    invoices,
    sellers: new Map(sellers.map((seller) => [seller.id, seller])),
    originals: new Map(
      originals.map((original) => [original.id, original.invoiceNumber]),
    ),
    timekeepers: new Map(timekeepers.map((u) => [u.id, u.name])),
    timeZone: await readOrganizationTimeZone(tx, organizationId),
  };
};

type LoadedExport = Awaited<ReturnType<typeof loadInvoiceExport>>;
type LoadedInvoice = LoadedExport["invoices"][number];
/** The lines and totals `readInvoiceDocumentLines` computes for a document. */
type DocumentAmounts = {
  lines: readonly (InvoiceLine & {
    quantity: string | null;
    unit: string | null;
    unitPrice: CentsAmount | null;
  })[];
  totals: InvoiceTotals;
};

const exportLines = (
  invoice: LoadedInvoice,
  amounts: DocumentAmounts,
  timekeepers: LoadedExport["timekeepers"],
): InvoiceExportLine[] => {
  const timeEntries = new Map(
    invoice.timeEntries.map((entry) => [entry.id, entry]),
  );
  const expenses = new Map(
    invoice.expenses.map((expense) => [expense.id, expense]),
  );
  return amounts.lines.map((line, index): InvoiceExportLine => {
    // Stored lines come first, in the order the document prints them.
    const stored = invoice.lines.at(index);
    const entry = stored?.timeEntryId
      ? timeEntries.get(stored.timeEntryId)
      : undefined;
    const expense = stored?.expenseId
      ? expenses.get(stored.expenseId)
      : undefined;
    return {
      position: index + 1,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unitPriceMinor: line.unitPrice,
      netAmountMinor: line.netAmountMinor,
      vatAmountMinor: line.vatAmountMinor,
      grossAmountMinor: line.grossAmountMinor,
      vatRateBps: line.vatRateBps,
      vatTreatment: line.vatTreatment,
      source: stored?.source ?? "manual",
      date: entry?.dateWorked ?? expense?.dateIncurred ?? null,
      timekeeper: entry?.userId
        ? { id: entry.userId, name: timekeepers.get(entry.userId) ?? "" }
        : null,
      taskCode: entry?.taskCode ?? null,
      activityCode: entry?.activityCode ?? null,
      expenseCode: expense
        ? (UTBMS_EXPENSE_CODE.get(expense.category) ?? null)
        : null,
    };
  });
};

const exportSellerOf = (
  seller: NonNullable<ReturnType<LoadedExport["sellers"]["get"]>>,
): InvoiceExportSeller => ({
  ...partyOf(seller.legalName, {
    registrationNumber: seller.registrationId,
    vatId: seller.vatId,
    addressLine1: seller.addressLine1,
    addressLine2: seller.addressLine2,
    city: seller.city,
    postalCode: seller.postalCode,
    country: seller.country,
  }),
  ...(presentText(seller.iban) ? { iban: seller.iban } : {}),
  ...(presentText(seller.bic) ? { bic: seller.bic } : {}),
  ...(presentText(seller.accountNumber)
    ? { accountNumber: seller.accountNumber }
    : {}),
  homeCurrency: seller.defaultCurrency,
});

/**
 * The loaded invoices as export records. Refused when a selected invoice is
 * not an issued one in this matter, or an invoice has no seller profile:
 * accounting files name the issuing company.
 */
export const toExportRecords = (
  loaded: LoadedExport,
  selected: readonly string[] | undefined,
): Result<InvoiceExportRecord[], HandlerError> => {
  const { matter } = loaded;
  if (!matter) {
    return Result.err(
      new HandlerError({ status: 404, message: "Matter not found" }),
    );
  }
  if (selected && loaded.invoices.length !== new Set(selected).size) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Only issued invoices in this matter can be exported",
        hint: "Drafts and void invoices have no export; finalize the draft first.",
      }),
    );
  }
  if (loaded.invoices.length === 0) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "The matter has no issued invoices to export",
      }),
    );
  }
  const records: InvoiceExportRecord[] = [];
  for (const invoice of loaded.invoices) {
    const seller =
      invoice.sellerProfileId === null
        ? undefined
        : loaded.sellers.get(invoice.sellerProfileId);
    if (!seller || invoice.invoiceNumber === null) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: `Invoice ${invoice.invoiceNumber ?? invoice.id} has no seller profile`,
          hint: "Select a seller profile on the invoice; accounting files need the issuing company.",
        }),
      );
    }
    if (!isExportable(invoice.status)) {
      continue;
    }
    const amounts = readInvoiceDocumentLines(invoice);
    if (amounts.isErr()) {
      return Result.err(amounts.error);
    }
    records.push({
      id: invoice.id,
      number: invoice.invoiceNumber,
      documentType: invoice.documentType,
      originalNumber:
        invoice.originalInvoiceId === null
          ? null
          : (loaded.originals.get(invoice.originalInvoiceId) ?? null),
      status: invoice.status,
      issueDate: invoice.invoiceDate,
      taxableSupplyDate: invoice.taxableSupplyDate,
      dueDate: invoice.dueDate,
      paidDate:
        invoice.paidAt === null
          ? null
          : todayFor(
              loaded.timeZone,
              Temporal.Instant.fromEpochMilliseconds(invoice.paidAt.getTime()),
            ).toString(),
      currency: invoice.currency,
      reference: invoice.reference,
      notes: invoice.notes,
      matter: { id: matter.id, name: matter.name, reference: matter.reference },
      seller: exportSellerOf(seller),
      buyer: partyOf(invoice.buyerName ?? "", {
        registrationNumber: invoice.buyerRegistrationId,
        vatId: invoice.buyerVatId,
        addressLine1: invoice.buyerAddressLine1,
        addressLine2: invoice.buyerAddressLine2,
        city: invoice.buyerCity,
        postalCode: invoice.buyerPostalCode,
        country: invoice.buyerCountry,
      }),
      lines: exportLines(invoice, amounts.value, loaded.timekeepers),
      totals: amounts.value.totals,
    });
  }
  return Result.ok(records);
};
