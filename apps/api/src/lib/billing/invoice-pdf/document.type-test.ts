import { expectTypeOf } from "bun:test";

import {
  invoiceDocumentRenderOptions,
  renderInvoiceDocumentPdf,
} from "./document";
import type { InvoiceDocumentSource } from "./document";
import type { RenderInvoicePdfOptions } from "./render-helpers";
import { buildInvoiceTemplateData } from "./typst/data";

const renderWithoutPaymentSnapshot = async (
  loaded: InvoiceDocumentSource,
  invoice: Omit<RenderInvoicePdfOptions, "settlement">,
) => {
  // @ts-expect-error Document rendering requires the caller's payment ledger.
  const rendered = await renderInvoiceDocumentPdf({ loaded });
  // @ts-expect-error Mapping document totals cannot omit the payment ledger.
  invoiceDocumentRenderOptions(loaded);
  // @ts-expect-error Templates cannot silently fall back to the gross total.
  const templateData = buildInvoiceTemplateData(invoice);
  return { rendered, templateData };
};

expectTypeOf(renderWithoutPaymentSnapshot).toBeFunction();
