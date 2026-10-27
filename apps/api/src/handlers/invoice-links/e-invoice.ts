import { Result } from "better-result";

import { invoiceCountryOf } from "@stll/invoicing";
import type { InvoiceCountry } from "@stll/invoicing";

import type { Transaction } from "@/api/db/root";
import { buildInvoiceExportFile } from "@/api/handlers/invoices/export-file";
import type { INVOICE_EXPORT_FORMATS } from "@/api/handlers/invoices/export-file";
import {
  loadInvoiceExport,
  toExportRecords,
} from "@/api/handlers/invoices/export-records";
import type { InvoiceDocument } from "@/api/handlers/invoices/pdf/document";
import type { SafeId } from "@/api/lib/branded-types";
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

const eInvoiceFormatOf = (document: InvoiceDocument) =>
  E_INVOICE_FORMAT[
    invoiceCountryOf(document.seller ?? { country: null, vatId: null })
  ];

type EInvoiceScope = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  document: InvoiceDocument;
};

/**
 * The invoice's e-invoice file, null when its seller's country has none, or
 * the reason the format cannot hold this invoice.
 */
export const buildLinkedEInvoice = async (
  tx: Transaction,
  { organizationId, workspaceId, document }: EInvoiceScope,
) => {
  const format = eInvoiceFormatOf(document);
  if (format === null) {
    return Result.ok(null);
  }
  const invoiceIds = [document.invoice.id];
  const loaded = await loadInvoiceExport(tx, {
    organizationId,
    workspaceId,
    invoiceIds,
  });
  const records = toExportRecords(loaded, invoiceIds);
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
