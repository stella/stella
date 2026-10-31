import { PDF } from "@libpdf/core";
import { afterAll, describe, expect, test } from "bun:test";

import type { VatTreatment } from "@stll/invoicing";
import { cents, formatMoneyCents } from "@stll/money";

import {
  invoicePaymentState,
  paidAmountOf,
} from "@/api/lib/billing/invoice-payment-amounts";

import { buildInvoicePaymentPayload } from "./render-helpers";
import type { RenderInvoicePdfOptions } from "./render-helpers";
import { buildInvoiceTemplateData } from "./typst/data";
import { renderInvoiceWithTypst } from "./typst/render-typst";
import { openTypstSession } from "./typst/session";

const session = openTypstSession();
afterAll(async () => {
  await session.close();
});

// Golden Slovak invoices, one per VAT case. Each asserts the content that
// zákon č. 222/2004 Z. z. o dani z pridanej hodnoty (consolidation in force
// from 2026-01-01), § 74 ods. 1, requires on the rendered PDF.

type GoldenLine = {
  netAmount: number;
  vatAmount: number;
  vatRateBps: number;
  vatTreatment: VatTreatment;
  exemptionReason?: string;
};

const seller = {
  legalName: "Mgr. Ľubica Ďurišová, advokátka",
  registrationId: "50123456",
  taxId: "2120123456",
  vatId: "SK2120123456",
  addressLine1: "Štúrova 7",
  addressLine2: null,
  city: "Bratislava",
  postalCode: "811 02",
  country: "SK",
  iban: "SK3112000000198742637541",
  bic: "TATRSKBX",
  accountNumber: null,
  registerEntry: null,
  barRegistration: "Slovenská advokátska komora, č. 0000",
  footerNotes: null,
} satisfies RenderInvoicePdfOptions["seller"];

const golden = ({
  line,
  sellerVatId = seller.vatId,
  buyerVatId,
  buyerCountry,
}: {
  line: GoldenLine;
  sellerVatId?: string | null;
  buyerVatId: string | null;
  buyerCountry: string;
}): RenderInvoicePdfOptions => ({
  invoice: {
    status: "finalized",
    documentType: "invoice",
    invoiceNumber: "2026-0042",
    invoiceDate: "2026-10-19",
    dueDate: "2026-11-02",
    taxableSupplyDate: "2026-10-15",
    currency: "EUR",
    language: "sk",
    reference: "20260042",
    notes: null,
    buyerName: "Šťastný a Ďuriš s. r. o.",
    buyerRegistrationId: "47123456",
    buyerTaxId: buyerVatId?.startsWith("SK") ? "2020123456" : null,
    buyerVatId,
    buyerAddressLine1: "Hlavná 21",
    buyerAddressLine2: null,
    buyerCity: "Košice",
    buyerPostalCode: "040 01",
    buyerCountry,
    lines: [
      {
        workspaceId: "matter-one",
        workspaceName: "Právne poradenstvo",
        description: "Právne poradenstvo k zmluve o dielo",
        quantity: "4.0000",
        unit: "h",
        unitPrice: line.netAmount / 4,
        netAmount: line.netAmount,
        vatAmount: line.vatAmount,
        grossAmount: line.netAmount + line.vatAmount,
        vatRateBps: line.vatRateBps,
        vatTreatment: line.vatTreatment,
        exemptionReason: line.exemptionReason ?? null,
      },
    ],
  },
  seller: { ...seller, vatId: sellerVatId },
  totals: {
    netAmountMinor: cents(line.netAmount),
    vatAmountMinor: cents(line.vatAmount),
    grossAmountMinor: cents(line.netAmount + line.vatAmount),
    vatBreakdown: [
      {
        vatRateBps: line.vatRateBps,
        vatTreatment: line.vatTreatment,
        netAmountMinor: cents(line.netAmount),
        vatAmountMinor: cents(line.vatAmount),
        grossAmountMinor: cents(line.netAmount + line.vatAmount),
      },
    ],
  },
  settlement: {
    status: "due",
    amountMinor: cents(line.netAmount + line.vatAmount),
  },
  originalNumber: null,
});

const textOf = async (value: RenderInvoicePdfOptions) => {
  const outcome = (
    await renderInvoiceWithTypst({
      invoice: value,
      session,
      createdAt: new Date("2026-10-19T08:00:00Z"),
    })
  ).unwrap();
  if (outcome.status !== "rendered") {
    throw new Error(outcome.diagnostics.join("\n"));
  }
  const pdf = await PDF.load(outcome.pdf);
  return pdf
    .extractText()
    .map(({ text }) => text)
    .join("\n")
    .replace(/[  ]/gu, " ");
};

const euro = (amountCents: number) =>
  formatMoneyCents({ amountCents, currency: "EUR", locale: "sk-SK" }).replace(
    /[  ]/gu,
    " ",
  );

/** § 74 ods. 1 písm. a) to g): parties, number, dates, service, tax base. */
const expectCoreContent = (text: string, netAmount: number) => {
  for (const expected of [
    "Faktúra",
    "2026-0042",
    seller.legalName,
    "Štúrova 7",
    "Šťastný a Ďuriš s. r. o.",
    "Hlavná 21",
    "Dátum dodania",
    "Právne poradenstvo k zmluve o dielo",
    euro(netAmount),
  ]) {
    expect(text).toContain(expected);
  }
};

describe("golden Slovak invoices (zákon 222/2004 Z. z. § 74 ods. 1)", () => {
  test("VAT payer, domestic 23 %: seller and buyer IČ DPH, rate and VAT total in euro (písm. a, b, h, i)", async () => {
    const text = await textOf(
      golden({
        line: {
          netAmount: 60_000,
          vatAmount: 13_800,
          vatRateBps: 2300,
          vatTreatment: "domestic_vat",
        },
        buyerVatId: "SK2020123456",
        buyerCountry: "SK",
      }),
    );
    expectCoreContent(text, 60_000);
    expect(text).toContain("IČ DPH");
    expect(text).toContain("DIČ");
    expect(text).toContain("2120123456");
    expect(text).toContain("SK2120123456");
    expect(text).toContain("Slovenská advokátska komora, č. 0000");
    expect(text).toContain("SK2020123456");
    expect(text).toContain("23 %");
    expect(text).toContain(euro(13_800));
    expect(text).not.toContain("Prenesenie daňovej povinnosti");
  });

  test("seller not registered for VAT: no VAT charged and the reason stated", async () => {
    const text = await textOf(
      golden({
        line: {
          netAmount: 60_000,
          vatAmount: 0,
          vatRateBps: 0,
          vatTreatment: "not_vat_payer",
        },
        sellerVatId: null,
        buyerVatId: null,
        buyerCountry: "SK",
      }),
    );
    expectCoreContent(text, 60_000);
    expect(text).toContain("Dodávateľ nie je platiteľom DPH.");
  });

  test("EU business client: buyer VAT ID and „prenesenie daňovej povinnosti“ (písm. b, k)", async () => {
    const text = await textOf(
      golden({
        line: {
          netAmount: 60_000,
          vatAmount: 0,
          vatRateBps: 0,
          vatTreatment: "reverse_charge",
        },
        buyerVatId: "DE123456789",
        buyerCountry: "DE",
      }),
    );
    expectCoreContent(text, 60_000);
    expect(text).toContain("DE123456789");
    expect(text).toContain("Prenesenie daňovej povinnosti.");
  });

  test("exempt supply: „dodanie je oslobodené od dane“ with its legal reason (písm. h)", async () => {
    const reason = "§ 39 zákona č. 222/2004 Z. z.";
    const text = await textOf(
      golden({
        line: {
          netAmount: 60_000,
          vatAmount: 0,
          vatRateBps: 0,
          vatTreatment: "exempt",
          exemptionReason: reason,
        },
        buyerVatId: "SK2020123456",
        buyerCountry: "SK",
      }),
    );
    expectCoreContent(text, 60_000);
    expect(text).toContain("Dodanie je oslobodené od dane.");
    expect(text).toContain(reason);
  });

  test("a legal note prints once however many lines share its treatment", async () => {
    const options = golden({
      line: {
        netAmount: 60_000,
        vatAmount: 0,
        vatRateBps: 0,
        vatTreatment: "reverse_charge",
      },
      buyerVatId: "DE123456789",
      buyerCountry: "DE",
    });
    const [line] = options.invoice.lines;
    if (line === undefined) {
      throw new Error("golden invoice has a line");
    }
    const text = await textOf({
      ...options,
      invoice: { ...options.invoice, lines: [line, line, line] },
    });
    expect(text.split("Prenesenie daňovej povinnosti.").length - 1).toBe(1);
  });
});

describe("Slovak payment instructions follow settlement", () => {
  test.each([
    { name: "unpaid", paid: 0, voided: false, due: 12_345 },
    { name: "partly paid", paid: 2344, voided: false, due: 10_001 },
    { name: "fully paid", paid: 12_345, voided: false, due: 0 },
    { name: "voided payment", paid: 12_345, voided: true, due: 12_345 },
    { name: "one cent remaining", paid: 12_344, voided: false, due: 1 },
  ])(
    "$name keeps totals and prints the current payment instruction",
    async ({ paid, voided, due }) => {
      const base = golden({
        line: {
          netAmount: 12_345,
          vatAmount: 0,
          vatRateBps: 0,
          vatTreatment: "not_vat_payer",
        },
        sellerVatId: null,
        buyerVatId: null,
        buyerCountry: "SK",
      });
      const input = {
        ...base,
        seller: {
          ...seller,
          legalName: "Fiktívna kancelária Žltý príklad",
          registrationId: null,
          taxId: null,
          vatId: null,
        },
        invoice: {
          ...base.invoice,
          buyerName: "Fiktívny odberateľ Ľalia",
          buyerRegistrationId: null,
          buyerTaxId: null,
          reference: null,
          lines: base.invoice.lines.map((line) => ({
            ...line,
            quantity: "1",
            unitPrice: 12_345,
          })),
        },
        settlement: invoicePaymentState({
          documentType: base.invoice.documentType,
          totalAmount: 12_345,
          paidAmount: paidAmountOf([
            {
              amount: paid,
              voidedAt: voided ? new Date("2026-10-20T00:00:00Z") : null,
            },
          ]),
        }),
      };
      const data = buildInvoiceTemplateData(input).unwrap();
      const text = await textOf(input);
      expect(text).toContain(euro(12_345));
      expect(text).toContain("Variabilný symbol");
      expect(text).toContain("20260042");
      if (due === 0) {
        expect(data.payment).toEqual({
          status: "settled",
          statement: "Uhradené",
        });
        expect(buildInvoicePaymentPayload(input)).toBeNull();
        expect(text).toContain("Uhradené");
        expect(text).not.toContain("Na úhradu");
        return;
      }
      expect(data.payment?.status).toBe("due");
      if (data.payment?.status !== "due") {
        throw new TypeError("Expected payment instructions");
      }
      expect(data.payment.qrSvg).not.toBeNull();
      expect(data.payment.fields).toContainEqual({
        label: "Na úhradu",
        value: formatMoneyCents({
          amountCents: due,
          currency: "EUR",
          locale: "sk",
        }),
      });
      expect(text).toContain("Na úhradu");
      expect(text).toContain(euro(due));
    },
  );

  test.each(["SK", "CZ", "PL", "EU"] as const)(
    "%s profile selects the variable symbol independently of language",
    (country) => {
      const base = golden({
        line: {
          netAmount: 100,
          vatAmount: 0,
          vatRateBps: 0,
          vatTreatment: "not_vat_payer",
        },
        buyerVatId: null,
        buyerCountry: "SK",
      });
      const data = buildInvoiceTemplateData({
        ...base,
        seller: { ...seller, country },
        invoice: { ...base.invoice, language: "en", reference: "PO-42" },
      }).unwrap();
      expect(data.meta).toContainEqual({ label: "Reference", value: "PO-42" });
      expect(data.meta.some(({ label }) => label === "Variable symbol")).toBe(
        country === "SK" || country === "CZ",
      );
    },
  );
});
