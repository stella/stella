import { Result } from "better-result";

import { invoiceCountryOf } from "@stll/invoicing";
import type { InvoiceCountry } from "@stll/invoicing";

import type { loadLinkedInvoiceData } from "@/api/handlers/invoice-links/document";
import { buildInvoiceExportFile } from "@/api/lib/billing/invoice-export-file";
import type { INVOICE_EXPORT_FORMATS } from "@/api/lib/billing/invoice-export-file";
import { toExportRecords } from "@/api/lib/billing/invoice-export-records";
import type { LoadedInvoiceDocument } from "@/api/lib/billing/invoice-pdf/document";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";

type InvoiceExportFormat = (typeof INVOICE_EXPORT_FORMATS)[number];

/**
 * The structured e-invoice a recipient may download beside the PDF, by the
 * seller's country: ISDOC in Czechia, Peppol BIS Billing in Slovakia, UBL
 * (EN 16931) elsewhere. Poland has none here: an FA(3) document is an
 * invoice only once KSeF accepts it, so a file made outside KSeF would
 * mislead its reader.
 */
const E_INVOICE_FORMAT = {
  CZ: "isdoc",
  SK: "peppol_sk",
  PL: null,
  EU: "ubl",
} as const satisfies Record<InvoiceCountry, InvoiceExportFormat | null>;

const eInvoiceFormatOf = (document: LoadedInvoiceDocument) =>
  E_INVOICE_FORMAT[
    invoiceCountryOf(document.seller ?? { country: null, vatId: null })
  ];

type EInvoiceScope = NonNullable<
  Awaited<ReturnType<typeof loadLinkedInvoiceData>>
>;

/**
 * The invoice's e-invoice file, null when its seller's country has none, or
 * the reason the format cannot hold this invoice.
 */
export const buildLinkedEInvoice = async ({
  document,
  exportData,
}: EInvoiceScope) => {
  const format = eInvoiceFormatOf(document);
  if (format === null) {
    return Result.ok(null);
  }
  const invoiceIds = [document.invoice.id];
  const records = toExportRecords(exportData, invoiceIds);
  if (records.isErr()) {
    return Result.err(records.error);
  }
  const file = await buildInvoiceExportFile({
    format,
    records: records.value,
    lang: "en",
    packageId: `stella-${Bun.randomUUIDv7()}`,
  });
  if (file.isErr()) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: file.error.message,
      }),
    );
  }
  return Result.ok({
    ...file.value,
    format,
    fileName: sanitizeFilenamePreservingExtension(
      `invoice-${document.invoice.invoiceNumber ?? document.invoice.id}-${format.replaceAll("_", "-")}.${file.value.extension}`,
    ),
  });
};
