import { describe, expect, expectTypeOf, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { CentsAmount } from "@stll/money";

import type { PreparedSend } from "@/api/handlers/invoices/sends/create";
import type { AmountDue } from "@/api/lib/billing/invoice-payments";
import type {
  invoiceDocumentRenderOptions,
  renderInvoiceDocumentPdf,
} from "@/api/lib/billing/invoice-pdf/document";
import type {
  RenderInvoicePdfOptions,
  requestsPayment,
} from "@/api/lib/billing/invoice-pdf/render-helpers";

const apiRoot = path.resolve(import.meta.dir, "../../..");

/**
 * Every module that turns an invoice into a payment request a client sees:
 * the PDF payment block and its QR code, the link page, the invoice email.
 * Each one states the amount still due (`AmountDue`, minted only by
 * `invoiceAmountDue` from the total, issued credit notes and payments),
 * never the document total.
 */
const CLIENT_PAYMENT_RENDERERS = {
  "src/handlers/invoice-links/document.ts":
    "computes the link's amount due from its settlement projection",
  "src/handlers/invoice-links/file-preparation.ts":
    "renders the link's PDF download",
  "src/handlers/invoice-links/view.ts":
    "renders the link page's payment details and QR code",
  "src/handlers/invoices/pdf/export.ts": "renders the member's PDF export",
  "src/handlers/invoices/sends/create.ts":
    "states the amount due in the invoice email",
  "src/lib/billing/invoice-pdf/document.ts": "maps a document to render input",
  "src/lib/billing/invoice-pdf/render-helpers.ts":
    "builds the QR payment payload",
  "src/lib/billing/invoice-pdf/typst/data.ts": "builds the PDF payment block",
  "src/lib/billing/invoice-pdf/typst/render-typst.ts":
    "lays the template data out",
} as const;

const RENDERER_CALL =
  /\b(?:renderInvoiceDocumentPdf|invoiceDocumentRenderOptions|buildInvoiceTemplateData|buildInvoicePaymentPayload|requestsPayment|invoiceAmountDue|renderInvoiceWithTypst)\(/u;
const NOT_PRODUCT_SOURCE =
  /(?:\.test\.tsx?$|\.test-helpers\.ts$|type-test\.ts$|\/fixtures\.ts$|^src\/tests\/)/u;

describe("client-facing payment requests", () => {
  test("every module that requests a payment from a client is reviewed here", () => {
    const callers = [
      ...new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: apiRoot }),
    ]
      .filter((file) => !NOT_PRODUCT_SOURCE.test(file))
      .filter((file) =>
        RENDERER_CALL.test(readFileSync(path.join(apiRoot, file), "utf-8")),
      )
      .toSorted();
    expect(callers).toEqual(Object.keys(CLIENT_PAYMENT_RENDERERS).toSorted());
  });

  test("each renderer takes the amount due, not a plain amount", () => {
    expectTypeOf<
      RenderInvoicePdfOptions["paymentAmountMinor"]
    >().toEqualTypeOf<AmountDue>();
    expectTypeOf<
      Parameters<typeof invoiceDocumentRenderOptions>[1]
    >().toEqualTypeOf<AmountDue>();
    expectTypeOf<
      Parameters<typeof renderInvoiceDocumentPdf>[0]["paymentAmountMinor"]
    >().toEqualTypeOf<AmountDue>();
    expectTypeOf<
      Parameters<typeof requestsPayment>[0]["amountMinor"]
    >().toEqualTypeOf<AmountDue>();
    expectTypeOf<PreparedSend["amountDue"]>().toEqualTypeOf<AmountDue>();
    // A document total or any other plain amount is not an amount due.
    expectTypeOf<CentsAmount>().not.toExtend<AmountDue>();
    expectTypeOf<number>().not.toExtend<AmountDue>();
  });
});
