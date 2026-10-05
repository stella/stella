import { PDF } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import { cents, formatMoneyCents } from "@stll/money";

import { buildInvoicePaymentPayload, renderInvoicePdf } from "./render";
import type { RenderInvoicePdfOptions } from "./render";

const sampleLine = {
  description: "Příprava právního stanoviska",
  quantity: "2.5000",
  unit: "h",
  unitPrice: 22_222,
  netAmount: 55_555,
  vatAmount: 0,
  grossAmount: 55_555,
  vatRateBps: 0,
  vatTreatment: "not_vat_payer",
} as const;

const options = {
  invoice: {
    status: "finalized",
    documentType: "invoice",
    invoiceNumber: "2026-001",
    invoiceDate: "2026-09-30",
    dueDate: "2026-10-14",
    taxableSupplyDate: "2026-09-30",
    currency: "CZK",
    reference: "0987654321",
    notes: "Vyřízení záležitosti bez dalších průtahů.",
    buyerName: "Řehoř Žďárský",
    buyerRegistrationId: "01234567",
    buyerVatId: "CZ01234567",
    buyerAddressLine1: "Příčná 12",
    buyerAddressLine2: null,
    buyerCity: "České Budějovice",
    buyerPostalCode: "370 01",
    buyerCountry: "CZ",
    lines: [sampleLine],
  },
  seller: {
    legalName: "Advokátní kancelář Černý",
    registrationId: "87654321",
    vatId: null,
    addressLine1: "Široká 4",
    addressLine2: null,
    city: "Praha",
    postalCode: "110 00",
    country: "CZ",
    iban: "CZ33 0100 0000 0000 0297 0297",
    bic: "KOMBCZPP",
    accountNumber: "2970297/0100",
    footerNotes: "Děkujeme za spolupráci.",
  },
  totals: {
    netAmountMinor: cents(55_555),
    vatAmountMinor: cents(0),
    grossAmountMinor: cents(55_555),
    vatBreakdown: [],
  },
  originalNumber: null,
  locale: "cs-CZ",
  lang: "cs",
} satisfies RenderInvoicePdfOptions;

const textOf = async (value: RenderInvoicePdfOptions) => {
  const pdf = await PDF.load((await renderInvoicePdf(value)).unwrap());
  return {
    pdf,
    text: pdf
      .extractText()
      .map(({ text }) => text)
      .join("\n"),
  };
};

describe("invoice PDF", () => {
  test("embeds Czech diacritics, parties, descriptions and formatted monetary values", async () => {
    const { text } = await textOf(options);
    for (const expected of [
      "Faktura",
      "2026-001",
      options.invoice.buyerName,
      options.seller.legalName,
      sampleLine.description,
      options.invoice.notes,
      options.seller.footerNotes,
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).toContain(
      formatMoneyCents({
        amountCents: 55_555,
        currency: "CZK",
        locale: "cs-CZ",
      }).replace(/[\u00a0\u202f]/gu, " "),
    );
  });

  test("prints each line's quantity, unit and unit price in the reader's number format", async () => {
    const { text } = await textOf({
      ...options,
      invoice: {
        ...options.invoice,
        lines: [
          sampleLine,
          { ...sampleLine, quantity: "1234.5", unit: null, unitPrice: 100 },
          { ...sampleLine, quantity: "3", unit: "ks", unitPrice: 300 },
        ],
      },
    });
    const spaced = (value: string) => value.replace(/[  ]/gu, " ");
    const price = (amountCents: number) =>
      spaced(
        formatMoneyCents({ amountCents, currency: "CZK", locale: "cs-CZ" }),
      );
    const flat = spaced(text);
    expect(flat).toContain("Množství: 2,5 h");
    expect(flat).toContain(`Jednotková cena: ${price(22_222)}`);
    expect(flat).toContain("Množství: 1 234,5");
    expect(flat).toContain(`Jednotková cena: ${price(100)}`);
    expect(flat).toContain("Množství: 3 ks");
    expect(flat).toContain(`Jednotková cena: ${price(300)}`);
  });

  test("prints a quantity a double cannot hold exactly as it is stored", async () => {
    const { text } = await textOf({
      ...options,
      invoice: {
        ...options.invoice,
        lines: [{ ...sampleLine, quantity: "12345678901234.5678" }],
      },
    });
    expect(text).toContain("12345678901234.5678");
  });

  test("leaves quantity and unit price off a line that was never billed by quantity", async () => {
    const { text } = await textOf({
      ...options,
      invoice: {
        ...options.invoice,
        lines: [{ ...sampleLine, quantity: null, unit: null, unitPrice: null }],
      },
    });
    expect(text).toContain(sampleLine.description);
    expect(text).not.toContain("Množství");
    expect(text).not.toContain("Jednotková cena");
  });

  test("wraps and paginates long descriptions and notes without losing their ending", async () => {
    const description = `${"Právní zastoupení a příprava podání. ".repeat(200)}KONEC POPISU`;
    const notes = `${"Doplňující smluvní podmínky. ".repeat(200)}KONEC POZNÁMEK`;
    const { pdf, text } = await textOf({
      ...options,
      invoice: {
        ...options.invoice,
        notes,
        lines: [{ ...sampleLine, description }],
      },
    });
    expect(pdf.getPages().length).toBeGreaterThan(1);
    expect(text).toContain("KONEC POPISU");
    expect(text).toContain("KONEC POZNÁMEK");
    expect(text).toContain(options.seller.footerNotes);
  });

  test("shows negative credit amounts and their original invoice", async () => {
    const credit = {
      ...options,
      originalNumber: "2026-ORIGINAL",
      invoice: {
        ...options.invoice,
        documentType: "credit_note",
        invoiceNumber: "2026-CREDIT",
        lines: [{ ...sampleLine, netAmount: -55_555, grossAmount: -55_555 }],
      },
      totals: {
        ...options.totals,
        netAmountMinor: cents(-55_555),
        grossAmountMinor: cents(-55_555),
      },
    } satisfies RenderInvoicePdfOptions;
    const { text } = await textOf(credit);
    expect(text).toContain("Dobropis");
    expect(text).toContain("2026-ORIGINAL");
    expect(text).toContain(
      formatMoneyCents({
        amountCents: -55_555,
        currency: "CZK",
        locale: "cs-CZ",
      }).replace(/[\u00a0\u202f]/gu, " "),
    );
    expect(buildInvoicePaymentPayload(credit)).toBeNull();
  });

  test("drafts suppress a stale invoice number in visible text and QR message", async () => {
    const draft = {
      ...options,
      invoice: {
        ...options.invoice,
        status: "draft",
        invoiceNumber: "STALE-NUMBER",
      },
    } satisfies RenderInvoicePdfOptions;
    const { text } = await textOf(draft);
    expect(text).toContain("Koncept");
    expect(text).not.toContain("STALE-NUMBER");
    expect(buildInvoicePaymentPayload(draft)?.unwrap()).toEqual({
      status: "payable",
      payload:
        "SPD*1.0*ACC:CZ3301000000000002970297*AM:555.55*CC:CZK*X-VS:0987654321*DT:20261014",
    });
  });
});

describe("invoice QR payment", () => {
  test("matches canonical SPAYD account, amount, symbol, due date and message", () => {
    expect(buildInvoicePaymentPayload(options)?.unwrap()).toEqual({
      status: "payable",
      payload:
        "SPD*1.0*ACC:CZ3301000000000002970297*AM:555.55*CC:CZK*X-VS:0987654321*DT:20261014*MSG:2026-001",
    });
  });

  test("skips QR for zero, negative, credit notes or missing IBAN", () => {
    for (const grossAmountMinor of [cents(0), cents(-1)]) {
      expect(
        buildInvoicePaymentPayload({
          ...options,
          totals: { ...options.totals, grossAmountMinor },
        }),
      ).toBeNull();
    }
    expect(
      buildInvoicePaymentPayload({
        ...options,
        invoice: { ...options.invoice, documentType: "credit_note" },
      }),
    ).toBeNull();
    expect(buildInvoicePaymentPayload({ ...options, seller: null })).toBeNull();
    expect(
      buildInvoicePaymentPayload({
        ...options,
        seller: { ...options.seller, iban: null },
      }),
    ).toBeNull();
  });
});
