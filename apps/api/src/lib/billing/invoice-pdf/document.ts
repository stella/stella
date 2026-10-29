import { panic, Result } from "better-result";

import { classifyFailure } from "@stll/errors";

import type { Transaction } from "@/api/db/root";
import { INVOICE_STATUS } from "@/api/db/schema";
import {
  INVOICE_DOCUMENT_COLUMNS,
  INVOICE_DOCUMENT_RELATIONS,
  INVOICE_SELLER_COLUMNS,
} from "@/api/lib/billing/invoice-detail";
import { readInvoiceDocumentLines } from "@/api/lib/billing/invoice-lines";
import type { RenderInvoicePdfOptions } from "@/api/lib/billing/invoice-pdf/render-helpers";
import { renderInvoiceWithTypst } from "@/api/lib/billing/invoice-pdf/typst/render-typst";
import { openTypstSession } from "@/api/lib/billing/invoice-pdf/typst/session";
import type { TypstRenderOutcome } from "@/api/lib/billing/invoice-pdf/typst/session";
import { invoiceInMatter } from "@/api/lib/billing/invoice-scope";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";

/**
 * One invoice as its document: everything the PDF prints, loaded in the
 * caller's transaction and laid out by the same template whoever asks (a
 * member exporting it, or a recipient opening the link it was sent with).
 */

const invoiceTypstSession = openTypstSession();

type InvoiceDocumentScope = {
  organizationId: SafeId<"organization">;
  /** A matter the invoice bills; it scopes the reads to that client. */
  workspaceId: SafeId<"workspace">;
  invoiceId: SafeId<"invoice">;
};

/** Everything the document prints, or null when the invoice is not visible. */
export const loadInvoiceDocument = async (
  tx: Transaction,
  { organizationId, workspaceId, invoiceId }: InvoiceDocumentScope,
) => {
  const invoice = await tx.query.invoices.findFirst({
    where: {
      id: { eq: invoiceId },
      RAW: (table) => invoiceInMatter(table, workspaceId),
      organizationId: { eq: organizationId },
    },
    columns: INVOICE_DOCUMENT_COLUMNS,
    with: INVOICE_DOCUMENT_RELATIONS,
  });
  if (!invoice) {
    return null;
  }
  const seller =
    invoice.sellerProfileId === null
      ? null
      : await tx.query.sellerProfiles.findFirst({
          where: {
            id: { eq: invoice.sellerProfileId },
            organizationId: { eq: organizationId },
          },
          columns: INVOICE_SELLER_COLUMNS,
        });
  const original =
    invoice.originalInvoiceId === null
      ? null
      : await tx.query.invoices.findFirst({
          where: {
            id: { eq: invoice.originalInvoiceId },
            RAW: (table) => invoiceInMatter(table, workspaceId),
            organizationId: { eq: organizationId },
          },
          columns: { invoiceNumber: true },
        });
  const matter = await tx.query.workspaces.findFirst({
    where: { id: { eq: workspaceId } },
    columns: { name: true },
  });
  return {
    matterName: matter?.name ?? panic("Authorized invoice matter disappeared"),
    workspaceId,
    invoice,
    seller: seller ?? null,
    originalNumber: original?.invoiceNumber ?? null,
  };
};

type LoadedInvoiceDocument = NonNullable<
  Awaited<ReturnType<typeof loadInvoiceDocument>>
>;

/** A document needs billed source amounts, not internal time-entry state or identity. */
export type InvoiceDocumentSource = Omit<LoadedInvoiceDocument, "invoice"> & {
  invoice: Omit<LoadedInvoiceDocument["invoice"], "timeEntries" | "expenses"> &
    Pick<
      Parameters<typeof readInvoiceDocumentLines>[0],
      "timeEntries" | "expenses"
    >;
};

/** Why a loaded invoice cannot be laid out, or null when it can. */
export const invoiceDocumentError = (
  loaded: InvoiceDocumentSource,
): HandlerError | null => {
  if (loaded.invoice.sellerProfileId !== null && loaded.seller === null) {
    return new HandlerError({
      status: 409,
      message: "Invoice seller profile is unavailable",
      hint: "Select an available seller profile before exporting the invoice.",
    });
  }
  if (
    loaded.invoice.documentType === "credit_note" &&
    loaded.originalNumber === null
  ) {
    return new HandlerError({
      status: 409,
      message: "Original invoice number is unavailable",
      hint: "The credit note must reference an issued invoice in this matter.",
    });
  }
  return null;
};

/** The render input for a loaded invoice, with its lines and totals. */
export const invoiceDocumentRenderOptions = (
  loaded: InvoiceDocumentSource,
): RenderInvoicePdfOptions => {
  const amounts = readInvoiceDocumentLines(loaded.invoice);
  return {
    ...loaded,
    invoice: {
      ...loaded.invoice,
      lines: amounts.lines.map((line, index) => {
        // Stored lines come first; a legacy invoice follows them with lines
        // for its attached entries, which belong to the invoice's own matter.
        const stored = loaded.invoice.lines.at(index);
        const matter = stored
          ? (stored.workspace ?? panic("Invoice line matter is missing"))
          : null;
        return {
          workspaceId: stored ? stored.workspaceId : loaded.workspaceId,
          workspaceName: matter ? matter.name : loaded.matterName,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
          netAmount: line.netAmountMinor,
          vatAmount: line.vatAmountMinor,
          grossAmount: line.grossAmountMinor,
          vatRateBps: line.vatRateBps,
          vatTreatment: line.vatTreatment,
          exemptionReason: line.exemptionReason,
        };
      }),
    },
    totals: amounts.totals,
  };
};

/** The PDF's file name: its number, or `draft` before it has one. */
export const invoicePdfFileName = (
  invoice: InvoiceDocumentSource["invoice"],
) => {
  const number =
    invoice.status === INVOICE_STATUS.DRAFT ? "draft" : invoice.invoiceNumber;
  return sanitizeFilenamePreservingExtension(
    `invoice-${number ?? invoice.id}.pdf`,
  );
};

const invoiceRenderError = (cause: unknown) => {
  if (cause instanceof HandlerError) {
    return cause;
  }
  return new HandlerError({
    status: 409,
    message:
      cause instanceof Error
        ? cause.message
        : "The invoice PDF could not be rendered.",
    hint: "Check the seller payment details and invoice dates before exporting.",
    cause,
  });
};

type InvoiceRenderRejection = Extract<
  TypstRenderOutcome,
  { status: "rejected" }
>;

// Renderer infrastructure failures are retryable; any other rejection names
// invoice data the user must correct.
const invoiceRenderRejection = ({
  reason,
  diagnostics,
}: InvoiceRenderRejection) => {
  const infrastructureFailure = ["timeout", "crashed", "memory"].includes(
    reason,
  );
  return classifyFailure(
    new HandlerError({
      status: infrastructureFailure ? 503 : 409,
      code: "internal_error",
      message: infrastructureFailure
        ? "The invoice PDF renderer is temporarily unavailable."
        : diagnostics.join("\n") || `Invoice rendering was rejected: ${reason}`,
      hint: infrastructureFailure
        ? "Try exporting the invoice again later."
        : "Check the seller payment details and invoice dates before exporting.",
      retryable: infrastructureFailure,
    }),
    infrastructureFailure ? "invoice_renderer_failed" : "conflict",
  );
};

export type InvoicePdfRenderer = typeof renderInvoiceWithTypst;

/** Lays a loaded invoice out as its PDF bytes. */
export const renderInvoiceDocumentPdf = async (
  loaded: InvoiceDocumentSource,
  renderInvoice: InvoicePdfRenderer = renderInvoiceWithTypst,
): Promise<Result<Uint8Array, HandlerError>> => {
  const outcome = await Result.tryPromise({
    try: async () =>
      await renderInvoice({
        session: invoiceTypstSession,
        createdAt: new Date(),
        invoice: invoiceDocumentRenderOptions(loaded),
      }),
    catch: invoiceRenderError,
  });
  if (outcome.isErr()) {
    return Result.err(invoiceRenderError(outcome.error));
  }
  if (outcome.value.isErr()) {
    return Result.err(invoiceRenderError(outcome.value.error));
  }
  if (outcome.value.value.status === "rejected") {
    return Result.err(invoiceRenderRejection(outcome.value.value));
  }
  return Result.ok(outcome.value.value.pdf);
};
