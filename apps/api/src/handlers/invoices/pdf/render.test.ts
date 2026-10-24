import { PDF } from "@libpdf/core";
import { afterAll, describe, expect, test } from "bun:test";

import { cents, formatMoneyCents } from "@stll/money";

import { buildInvoicePaymentPayload } from "./render-helpers";
import type { RenderInvoicePdfOptions } from "./render-helpers";
import { renderInvoiceWithTypst } from "./typst/render-typst";
import { openTypstSession } from "./typst/session";

const session = openTypstSession();
afterAll(async () => {
  await session.close();
});

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
    language: "cs",
    reference: "0987654321",
    notes: "Vyřízení záležitosti bez dalších průtahů.",
    buyerName: "Řehoř Žďárský",
    buyerRegistrationId: "01234567",
    buyerTaxId: "2020123456",
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
    taxId: "2020876543",
    vatId: "CZ87654321",
    addressLine1: "Široká 4",
    addressLine2: null,
    city: "Praha",
    postalCode: "110 00",
    country: "CZ",
    iban: "CZ33 0100 0000 0000 0297 0297",
    bic: "KOMBCZPP",
    accountNumber: "2970297/0100",
    registerEntry: "Fictional register, entry 00000",
    barRegistration: "Fictional bar, no. 0000",
    footerNotes: "Děkujeme za spolupráci.",
  },
  totals: {
    netAmountMinor: cents(55_555),
    vatAmountMinor: cents(0),
    grossAmountMinor: cents(55_555),
    vatBreakdown: [],
  },
  originalNumber: null,
} satisfies RenderInvoicePdfOptions;

const textOf = async (value: RenderInvoicePdfOptions) => {
  const outcome = (
    await renderInvoiceWithTypst({
      invoice: value,
      session,
      createdAt: new Date("2026-09-30T08:00:00Z"),
    })
  ).unwrap();
  if (outcome.status !== "rendered") {
    throw new Error(outcome.diagnostics.join("\n"));
  }
  const pdf = await PDF.load(outcome.pdf);
  return {
    pdf,
    text: pdf
      .extractText()
      .map(({ text }) => text)
      .join("\n")
      .replace(/[  ]/gu, " "),
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
    expect(text).toContain("DIČ: 2020123456");
    expect(text).toContain("DIČ: 2020876543");
    expect(text).toContain("CZ01234567");
    expect(text).toContain("CZ87654321");
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
      errorCorrection: "M",
      scheme: "spayd",
      payload:
        "SPD*1.0*ACC:CZ3301000000000002970297*AM:555.55*CC:CZK*X-VS:0987654321*DT:20261014",
    });
  });
});

describe("invoice QR payment", () => {
  test("matches canonical SPAYD account, amount, symbol, due date and message", () => {
    expect(buildInvoicePaymentPayload(options)?.unwrap()).toEqual({
      status: "payable",
      errorCorrection: "M",
      scheme: "spayd",
      payload:
        "SPD*1.0*ACC:CZ3301000000000002970297*AM:555.55*CC:CZK*X-VS:0987654321*DT:20261014*MSG:2026-001",
    });
  });

  test("a Slovak account gets PAY by square, which Slovak banking apps read", () => {
    const slovak = {
      ...options,
      invoice: { ...options.invoice, currency: "EUR" },
      seller: { ...options.seller, iban: "SK96 1100 0000 0029 1859 9669" },
    } satisfies RenderInvoicePdfOptions;
    const payment = buildInvoicePaymentPayload(slovak)?.unwrap();
    expect(payment?.status).toBe("payable");
    // The header bytes 0x02 0x00 (pay, version 1.2.0) read "080" in base32hex.
    expect(payment?.status === "payable" && payment.payload).toMatch(
      /^080[0-9A-V]+$/u,
    );
    expect(
      buildInvoicePaymentPayload({
        ...slovak,
        seller: { ...slovak.seller, legalName: " " },
      })?.isErr(),
    ).toBe(true);
  });

  test("a Polish account gets the ZBP code, at error correction L", async () => {
    const polish = {
      ...options,
      invoice: { ...options.invoice, currency: "PLN" },
      seller: {
        ...options.seller,
        legalName: "Kancelaria Nowak i Wspólnicy sp.k.",
        vatId: "PL 526-000-12-46",
        iban: "PL61 1090 1014 0000 0712 1981 2874",
      },
    } satisfies RenderInvoicePdfOptions;
    expect(buildInvoicePaymentPayload(polish)?.unwrap()).toEqual({
      status: "payable",
      errorCorrection: "L",
      scheme: "zbp",
      payload:
        "5260001246|PL|61109010140000071219812874|055555|Kancelaria Nowak i W|2026-001|||",
    });
    // Not PLN: the ZBP code carries domestic transfers only.
    expect(
      buildInvoicePaymentPayload({
        ...polish,
        invoice: { ...polish.invoice, currency: "EUR" },
      })?.unwrap(),
    ).toEqual({
      status: "not_payable",
      reason: "not_pln",
      errorCorrection: "L",
      scheme: "zbp",
    });
    // No NIP on the seller profile, or a foreign VAT ID on a firm that banks
    // in Poland: no code, and the PDF still renders.
    for (const vatId of [null, "CZ27082440", "PL 526-000-12-47"]) {
      const seller = { ...polish.seller, vatId };
      expect(buildInvoicePaymentPayload({ ...polish, seller })).toBeNull();
    }
    const czechSeller = {
      ...polish,
      seller: { ...polish.seller, vatId: "CZ27082440" },
    } satisfies RenderInvoicePdfOptions;
    expect((await textOf(czechSeller)).text).toContain("Kancelaria Nowak");
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

describe("country invoice wording", () => {
  test("prints a Czech party's tax ID when it has no VAT ID", async () => {
    const { text } = await textOf({
      ...options,
      seller: { ...options.seller, taxId: "CZ8765432101", vatId: null },
      invoice: {
        ...options.invoice,
        buyerTaxId: "CZ0123456789",
        buyerVatId: null,
      },
    });
    expect(text).toContain("CZ8765432101");
    expect(text).toContain("CZ0123456789");
  });

  test.each(["sk", "en"] as const)(
    "prints mandated Slovak reverse-charge wording in %s",
    async (lang) => {
      const { text } = await textOf({
        ...options,
        seller: { ...options.seller, country: "SK", vatId: "SK1234567890" },
        invoice: {
          ...options.invoice,
          language: lang,
          lines: [{ ...sampleLine, vatTreatment: "reverse_charge" }],
        },
      });
      expect(text).toContain("Prenesenie daňovej povinnosti.");
      expect(text).toContain(
        lang === "sk" ? "Dátum dodania" : "Taxable supply date",
      );
    },
  );

  test("prints an exemption reason with the Slovak prescribed phrase", async () => {
    const { text } = await textOf({
      ...options,
      seller: { ...options.seller, country: "SK", vatId: "SK1234567890" },
      invoice: {
        ...options.invoice,
        language: "en",
        lines: [
          { ...sampleLine, vatTreatment: "exempt", exemptionReason: "§ 38" },
        ],
      },
    });
    expect(text).toContain("Dodanie je oslobodené od dane.");
    expect(text).toContain("§ 38");
  });

  test("prints Polish NIP labels, reverse charge wording, and exemption bases", async () => {
    const polish = {
      ...options,
      seller: {
        ...options.seller,
        country: "PL",
        taxId: "5260001246",
        vatId: "PL5260001246",
      },
      invoice: {
        ...options.invoice,
        currency: "PLN",
        language: "pl",
        buyerCountry: "PL",
        buyerTaxId: "7250018513",
        buyerVatId: null,
        lines: [
          { ...sampleLine, vatTreatment: "reverse_charge" },
          {
            ...sampleLine,
            vatTreatment: "exempt",
            exemptionReason: "art. 43 ust. 1 pkt 29",
          },
        ],
      },
    } satisfies RenderInvoicePdfOptions;
    const { text } = await textOf(polish);
    expect(text.match(/NIP/gu)).toHaveLength(3);
    expect(text).toContain("odwrotne obciążenie");
    expect(text).toContain("art. 43 ust. 1 pkt 29");
  });

  test("keeps the EU VAT label for a foreign buyer on a Polish invoice", async () => {
    const { text } = await textOf({
      ...options,
      seller: {
        ...options.seller,
        country: "PL",
        taxId: null,
        vatId: "PL5260001246",
      },
      invoice: {
        ...options.invoice,
        currency: "PLN",
        language: "pl",
        buyerCountry: "DE",
        buyerTaxId: null,
        buyerVatId: "DE123456789",
      },
    });
    expect(text).toContain("NIP");
    expect(text).toContain("Numer VAT");
  });

  test("prints a Czech exempt line's basis after the prescribed statement", async () => {
    const { text } = await textOf({
      ...options,
      invoice: {
        ...options.invoice,
        lines: [
          {
            ...sampleLine,
            vatTreatment: "exempt",
            exemptionReason: "§ 51 odst. 1 písm. a)",
          },
        ],
      },
    });
    expect(text).toContain("Plnění osvobozené od daně.");
    expect(text).toContain("§ 51 odst. 1 písm. a)");
  });

  test("labels a foreign buyer's tax ID as a tax ID, not a NIP, on a Polish invoice", async () => {
    const { text } = await textOf({
      ...options,
      seller: {
        ...options.seller,
        country: "PL",
        taxId: null,
        vatId: "PL5260001246",
      },
      invoice: {
        ...options.invoice,
        currency: "PLN",
        language: "pl",
        buyerCountry: "DE",
        buyerTaxId: "12/345/67890",
        buyerVatId: "DE123456789",
      },
    });
    // Only the Polish seller's identifier reads NIP.
    expect(text.match(/NIP/gu)).toHaveLength(1);
    expect(text).toContain("Numer identyfikacji podatkowej");
    expect(text).toContain("12/345/67890");
  });

  test("keeps Czech labels while adding the Czech profile note", async () => {
    const { text } = await textOf(options);
    expect(text).toContain("Datum zdanitelného plnění");
    expect(text).toContain("Dodavatel není plátcem DPH.");
  });
});
