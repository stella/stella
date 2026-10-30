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
  invoice: Omit<RenderInvoicePdfOptions, "paymentAmountMinor">,
) => {
  // @ts-expect-error Document rendering requires the caller's remaining balance.
  await renderInvoiceDocumentPdf({ loaded });
  // @ts-expect-error Mapping document totals cannot choose a payment amount.
  invoiceDocumentRenderOptions(loaded);
  // @ts-expect-error Templates cannot silently fall back to the gross total.
  buildInvoiceTemplateData(invoice);
};

expectTypeOf(renderWithoutPaymentSnapshot).toBeFunction();
