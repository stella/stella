import { panic, Result } from "better-result";

import type {
  InvoiceExportLine,
  InvoiceExportRecord,
  InvoiceExportSeller,
  InvoiceLine,
  InvoiceParty,
  InvoiceTotals,
} from "@stll/invoicing";
import type { CentsAmount } from "@stll/money";
import type { TimeZoneId } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { INVOICE_STATUS } from "@/api/db/schema";
import {
  INVOICE_DETAIL_RELATIONS,
  INVOICE_DOCUMENT_COLUMNS,
  INVOICE_SELLER_COLUMNS,
} from "@/api/lib/billing/invoice-detail";
import { readInvoiceDocumentLines } from "@/api/lib/billing/invoice-lines";
import {
  invoiceInMatter,
  invoiceTouchesMatter,
} from "@/api/lib/billing/invoice-scope";
import { invoiceSettledOn } from "@/api/lib/billing/invoice-settlement-date";
import { selectTimekeeperNames } from "@/api/lib/billing/timekeeper-names";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readOrganizationTimeZone } from "@/api/lib/organization-time-zone";

/**
 * The day an invoice was settled: the date of the latest payment still
 * counted, which is the one that reached its total. An invoice marked paid
 * before payments were recorded carries only the moment it was marked.
 */
export const exportPaidDate = (
  invoice: {
    status: string;
    paidAt: Date | null;
    payments: readonly { paidOn: string; voidedAt: Date | null }[];
  },
  timeZone: TimeZoneId,
): string | null => {
  let latestPaidOn: string | null = null;
  for (const payment of invoice.payments) {
    if (
      payment.voidedAt === null &&
      (latestPaidOn === null || payment.paidOn > latestPaidOn)
    ) {
      latestPaidOn = payment.paidOn;
    }
  }
  return invoiceSettledOn({
    status: invoice.status,
    paidAt: invoice.paidAt,
    latestPaidOn,
    timeZone,
  });
};

/**
 * The most invoices one export holds. Every line is built in memory before
 * the file is written, so a larger matter exports a selection at a time.
 */
export const MAX_EXPORT_INVOICES = 500;

/** Issued documents only: a draft has no number, a void one is not booked. */
const EXPORTABLE_STATUSES = [
  INVOICE_STATUS.FINALIZED,
  INVOICE_STATUS.SENT,
  INVOICE_STATUS.PAID,
] as const;
type ExportableStatus = (typeof EXPORTABLE_STATUSES)[number];
const EXPORTABLE_STATUS_SET: ReadonlySet<string> = new Set(EXPORTABLE_STATUSES);
const isExportable = (status: string): status is ExportableStatus =>
  EXPORTABLE_STATUS_SET.has(status);

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
  "taxId",
  "vatId",
  "addressLine1",
  "addressLine2",
  "city",
  "postalCode",
  "country",
] as const;

type StoredParty = Record<(typeof PARTY_FIELDS)[number], string | null>;

/**
 * Stored text as every export reads it: trimmed, and absent when blank. The
 * one place exports get identifiers from, so a format's validation and its
 * output never see different strings.
 */
const exportText = (value: string | null): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

/** A party as an export carries it: blank stored fields are left out. */
const partyOf = (name: string, stored: StoredParty): InvoiceParty => ({
  name,
  ...Object.fromEntries(
    PARTY_FIELDS.flatMap((field) => {
      const value = exportText(stored[field]);
      return value === null ? [] : [[field, value]];
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
      RAW: (table) =>
        invoiceIds === undefined
          ? invoiceTouchesMatter(table, workspaceId)
          : invoiceInMatter(table, workspaceId),
      organizationId: { eq: organizationId },
      status: { in: [...EXPORTABLE_STATUSES] },
      ...(invoiceIds ? { id: { in: [...invoiceIds] } } : {}),
    },
    orderBy: { invoiceDate: "asc", invoiceNumber: "asc" },
    // One more than the cap, so an oversized matter is refused, not cut off.
    limit: MAX_EXPORT_INVOICES + 1,
    columns: INVOICE_DOCUMENT_COLUMNS,
    with: EXPORT_RELATIONS,
  });
  const matterIds = [
    ...new Set(
      invoices.flatMap((invoice) => [
        ...(invoice.workspaceId === null ? [] : [invoice.workspaceId]),
        ...invoice.lines.map((line) => line.workspaceId),
        ...invoice.timeEntries.map(
          (entry) =>
            entry.workspaceId ?? panic("Invoiced time entry has no matter"),
        ),
        ...invoice.expenses.map((expense) => expense.workspaceId),
      ]),
    ),
  ];
  const matterRows =
    matterIds.length === 0
      ? []
      : await tx.query.workspaces.findMany({
          where: {
            id: { in: matterIds },
            organizationId: { eq: organizationId },
          },
          columns: { id: true, name: true, reference: true },
          limit: matterIds.length,
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
          columns: INVOICE_SELLER_COLUMNS,
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
            RAW: (table) => invoiceInMatter(table, workspaceId),
            organizationId: { eq: organizationId },
          },
          columns: { id: true, invoiceNumber: true, invoiceDate: true },
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
  const timeZone = await readOrganizationTimeZone(tx, organizationId);
  return {
    matter,
    matters: new Map(matterRows.map((row) => [row.id, row])),
    invoices: invoices.map(({ payments, ...invoice }) => ({
      ...invoice,
      paidDate: exportPaidDate({ ...invoice, payments }, timeZone),
    })),
    sellers: new Map(sellers.map((seller) => [seller.id, seller])),
    originals: new Map(
      originals.map((original) => [
        original.id,
        { number: original.invoiceNumber, issueDate: original.invoiceDate },
      ]),
    ),
    timekeepers: new Map(timekeepers.map((u) => [u.id, u.name])),
    timeZone,
  };
};

type AuthenticatedExport = Awaited<ReturnType<typeof loadInvoiceExport>>;
type AuthenticatedInvoice = AuthenticatedExport["invoices"][number];
type DocumentSourceAmounts = Parameters<typeof readInvoiceDocumentLines>[0];
type LoadedInvoice = Omit<AuthenticatedInvoice, "timeEntries" | "expenses"> & {
  timeEntries: readonly (DocumentSourceAmounts["timeEntries"][number] &
    Pick<
      AuthenticatedInvoice["timeEntries"][number],
      "workspaceId" | "dateWorked"
    > &
    Partial<
      Pick<
        AuthenticatedInvoice["timeEntries"][number],
        "userId" | "taskCode" | "activityCode"
      >
    >)[];
  expenses: readonly (DocumentSourceAmounts["expenses"][number] &
    Pick<
      AuthenticatedInvoice["expenses"][number],
      "workspaceId" | "dateIncurred"
    >)[];
};
type LoadedExport = Omit<AuthenticatedExport, "invoices" | "timekeepers"> & {
  invoices: readonly LoadedInvoice[];
  timekeepers?: AuthenticatedExport["timekeepers"];
};
/** The lines and totals `readInvoiceDocumentLines` computes for a document. */
type DocumentAmounts = {
  lines: readonly (InvoiceLine & {
    quantity: string | null;
    unit: string | null;
    unitPrice: CentsAmount | null;
    timeEntryId: SafeId<"timeEntry"> | null;
    expenseId: SafeId<"expense"> | null;
    exemptionReason: string | null;
  })[];
  totals: InvoiceTotals;
};

/** Where a line the read added for an attached entry came from. */
const sourceOf = (
  entry: object | undefined,
  expense: object | undefined,
): InvoiceExportLine["source"] => {
  if (entry !== undefined) {
    return "time_entry";
  }
  return expense === undefined ? "manual" : "expense";
};

type ExportLinesOptions = {
  invoice: LoadedInvoice;
  amounts: DocumentAmounts;
  loaded: LoadedExport;
};

const exportLines = ({
  invoice,
  amounts,
  loaded,
}: ExportLinesOptions): InvoiceExportLine[] => {
  const timeEntries = new Map(
    invoice.timeEntries.map((entry) => [entry.id, entry]),
  );
  const expenses = new Map(
    invoice.expenses.map((expense) => [expense.id, expense]),
  );
  return amounts.lines.map((line, index): InvoiceExportLine => {
    // Stored lines come first; an invoice from before lines adds one per
    // attached entry after them, which only the line's own ids identify.
    const stored = invoice.lines.at(index);
    const entry = line.timeEntryId
      ? timeEntries.get(line.timeEntryId)
      : undefined;
    const expense = line.expenseId ? expenses.get(line.expenseId) : undefined;
    const workspaceId =
      stored?.workspaceId ??
      entry?.workspaceId ??
      expense?.workspaceId ??
      invoice.workspaceId;
    const matter =
      workspaceId === null ? undefined : loaded.matters.get(workspaceId);
    if (matter === undefined) {
      return panic("Exported invoice line has no authorized matter metadata");
    }
    return {
      matter,
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
      exemptionReason: exportText(line.exemptionReason),
      source: stored?.source ?? sourceOf(entry, expense),
      date: entry?.dateWorked ?? expense?.dateIncurred ?? null,
      timekeeper: entry?.userId
        ? {
            id: entry.userId,
            name: loaded.timekeepers?.get(entry.userId) ?? "",
          }
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
): InvoiceExportSeller => {
  const iban = exportText(seller.iban);
  const bic = exportText(seller.bic);
  const accountNumber = exportText(seller.accountNumber);
  return {
    ...partyOf(seller.legalName, {
      registrationNumber: seller.registrationId,
      taxId: seller.taxId,
      vatId: seller.vatId,
      addressLine1: seller.addressLine1,
      addressLine2: seller.addressLine2,
      city: seller.city,
      postalCode: seller.postalCode,
      country: seller.country,
    }),
    ...(iban === null ? {} : { iban }),
    ...(bic === null ? {} : { bic }),
    ...(accountNumber === null ? {} : { accountNumber }),
    homeCurrency: seller.defaultCurrency,
  };
};

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
  if (loaded.invoices.length > MAX_EXPORT_INVOICES) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: `The matter has more than ${MAX_EXPORT_INVOICES} issued invoices to export at once`,
        hint: "Pass invoiceIds to export a selection of invoices at a time.",
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
    // The query reads issued invoices only; this narrows the status type.
    if (!isExportable(invoice.status) || invoice.invoiceNumber === null) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: `Invoice ${invoice.id} is not issued`,
        }),
      );
    }
    if (invoice.vatExchangeRate !== null) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: `Invoice ${invoice.invoiceNumber} includes VAT stated in the seller's home currency`,
          hint: "This export cannot yet carry the home-currency VAT; use the PDF.",
        }),
      );
    }
    if (!seller) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: `Invoice ${invoice.invoiceNumber} has no seller profile`,
          hint: "Select a seller profile on the invoice; accounting files need the issuing company.",
        }),
      );
    }
    const amounts = readInvoiceDocumentLines(invoice);
    const lines = exportLines({ invoice, amounts, loaded });
    const invoiceMatters = [
      ...new Map(lines.map((line) => [line.matter.id, line.matter])).values(),
    ];
    records.push({
      id: invoice.id,
      number: invoice.invoiceNumber,
      documentType: invoice.documentType,
      originalNumber:
        invoice.originalInvoiceId === null
          ? null
          : (loaded.originals.get(invoice.originalInvoiceId)?.number ?? null),
      originalIssueDate:
        invoice.originalInvoiceId === null
          ? null
          : (loaded.originals.get(invoice.originalInvoiceId)?.issueDate ??
            null),
      status: invoice.status,
      issueDate: invoice.invoiceDate,
      taxableSupplyDate: invoice.taxableSupplyDate,
      dueDate: invoice.dueDate,
      paidDate: invoice.paidDate,
      currency: invoice.currency,
      reference: invoice.reference,
      notes: invoice.notes,
      scope:
        invoice.workspaceId === null
          ? {
              type: "client",
              clientId:
                invoice.clientId ?? panic("Client invoice has no client"),
              matters: invoiceMatters,
            }
          : {
              type: "matter",
              matter:
                loaded.matters.get(invoice.workspaceId) ??
                panic("Invoice has no authorized matter metadata"),
            },
      seller: exportSellerOf(seller),
      buyer: partyOf(invoice.buyerName ?? "", {
        registrationNumber: invoice.buyerRegistrationId,
        taxId: invoice.buyerTaxId,
        vatId: invoice.buyerVatId,
        addressLine1: invoice.buyerAddressLine1,
        addressLine2: invoice.buyerAddressLine2,
        city: invoice.buyerCity,
        postalCode: invoice.buyerPostalCode,
        country: invoice.buyerCountry,
      }),
      lines,
      totals: amounts.totals,
    });
  }
  return Result.ok(records);
};
