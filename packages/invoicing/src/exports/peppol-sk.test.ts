import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { cents } from "@stll/money";
import { assertProperty } from "@stll/property-testing";

import { exportRecord } from "./exports.fixtures";
import { buildPeppolSkFiles } from "./peppol-sk";

const seller = {
  name: "Stella Legal s. r. o.",
  registrationNumber: "12345678",
  taxId: "2120123456",
  vatId: "SK2120123456",
  addressLine1: "Dunajská 1",
  city: "Bratislava",
  postalCode: "811 08",
  country: "SK",
  iban: "SK3112000000198742637541",
  bic: "TATRSKBX",
  homeCurrency: "EUR",
};

const buyer = {
  name: "Klient s. r. o.",
  registrationNumber: "87654321",
  taxId: "2020876543",
  vatId: "SK2020876543",
  addressLine1: "Hlavná 2",
  city: "Košice",
  postalCode: "040 01",
  country: "SK",
};

const peppolRecord = (seed: Parameters<typeof exportRecord>[0]) =>
  exportRecord({
    currency: "EUR",
    seller,
    buyer,
    scope: {
      type: "matter",
      matter: { id: "matter", name: "Advice", reference: null },
    },
    ...seed,
  });

const contentOf = (record: ReturnType<typeof peppolRecord>): string =>
  buildPeppolSkFiles([record]).unwrap().at(0)?.content ?? "";

const values = (xml: string, tag: string): number[] =>
  [
    ...xml.matchAll(new RegExp(`<${tag}[^>]*>(-?\\d+\\.\\d+)</${tag}>`, "gu")),
  ].map((match) => Number(match[1]));

describe("Peppol BIS Billing 3.0 for Slovak sellers", () => {
  test("golden: domestic invoice carries identifiers, payment, units, VAT, and balanced totals", () => {
    const xml = contentOf(
      peppolRecord({
        number: "2027-001",
        reference: "PO-7",
        lines: [
          {
            description: "Legal advice",
            quantity: "2.5000",
            unit: "hours",
            unitPriceMinor: cents(10_000),
            netAmountMinor: cents(25_000),
            vatRateBps: 2300,
          },
          {
            description: "Fixed fee",
            unit: "service",
            netAmountMinor: cents(10_000),
            vatRateBps: 2300,
          },
        ],
      }),
    );
    expect(xml).toMatchSnapshot();
    expect(xml).toContain('schemeID="0245">2120123456');
    expect(xml).toContain('schemeID="0245">2020876543');
    expect(xml).not.toContain('schemeID="9950"');
    expect(xml).toContain("<cbc:BuyerReference>PO-7</cbc:BuyerReference>");
    expect(xml).toContain("<cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>");
    expect(xml).toContain('unitCode="HUR"');
    expect(xml).toContain('unitCode="C62"');
    expect(xml).toContain("<cbc:ID>S</cbc:ID>");
    const declaredLineTotal = values(xml, "cbc:LineExtensionAmount").at(-3);
    expect(declaredLineTotal).toBeDefined();
    if (declaredLineTotal !== undefined) {
      expect(
        values(xml, "cbc:LineExtensionAmount")
          .slice(-2)
          .reduce((a, b) => a + b, 0),
      ).toBe(declaredLineTotal);
    }
  });

  test("golden: reverse charge carries AE and its VATEX code", () => {
    const xml = contentOf(
      peppolRecord({
        number: "2027-002",
        // Domestic reverse charge (zákon 222/2004 Z. z. § 69): both parties are Slovak.
        buyer: { ...buyer, name: "Domestic reverse-charge buyer" },
        lines: [
          {
            description: "EU advice",
            netAmountMinor: cents(20_000),
            vatTreatment: "reverse_charge",
            vatRateBps: 0,
          },
        ],
      }),
    );
    expect(xml).toMatchSnapshot();
    expect(xml).toContain("<cbc:ID>AE</cbc:ID>");
    expect(xml).toContain(
      "<cbc:TaxExemptionReasonCode>VATEX-EU-AE</cbc:TaxExemptionReasonCode>",
    );
  });

  test("golden: exemption carries the stored statutory basis", () => {
    const xml = contentOf(
      peppolRecord({
        number: "2027-003",
        lines: [
          {
            description: "Exempt service",
            netAmountMinor: cents(5000),
            vatTreatment: "exempt",
            vatRateBps: 0,
            exemptionReason: "§ 38 zákona o DPH",
          },
        ],
      }),
    );
    expect(xml).toMatchSnapshot();
    expect(xml).toContain("<cbc:ID>E</cbc:ID>");
    expect(xml).toContain(
      "<cbc:TaxExemptionReason>§ 38 zákona o DPH</cbc:TaxExemptionReason>",
    );
  });

  test("golden: credit note references the corrected invoice and date", () => {
    const xml = contentOf(
      peppolRecord({
        number: "2027-004",
        documentType: "credit_note",
        originalNumber: "2027-001",
        originalIssueDate: "2027-01-05",
        dueDate: null,
        lines: [
          {
            description: "Correction",
            netAmountMinor: cents(-10_000),
            vatRateBps: 2300,
          },
        ],
      }),
    );
    expect(xml).toMatchSnapshot();
    expect(xml).toStartWith(
      '<?xml version="1.0" encoding="UTF-8"?>\n<CreditNote ',
    );
    expect(xml).toContain(
      "<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>",
    );
    expect(xml).toContain(
      "<cac:InvoiceDocumentReference><cbc:ID>2027-001</cbc:ID><cbc:IssueDate>2027-01-05</cbc:IssueDate>",
    );
  });

  const { taxId: _sellerTaxId, ...sellerWithoutTaxId } = seller;
  const { taxId: _buyerTaxId, ...buyerWithoutTaxId } = buyer;
  const { iban: _sellerIban, ...sellerWithoutIban } = seller;
  const { vatId: _sellerVatId, ...sellerWithoutVatId } = seller;
  const { country: _buyerCountry, ...buyerWithoutCountry } = buyer;
  const {
    registrationNumber: _sellerRegistration,
    ...sellerWithoutRegistration
  } = seller;
  const {
    vatId: _buyerVatId,
    registrationNumber: _buyerRegistration,
    ...buyerWithoutIdentifiers
  } = buyer;
  const invalidRecords: readonly (readonly [
    string,
    () => ReturnType<typeof peppolRecord>,
  ])[] = [
    [
      "seller DIČ",
      () =>
        peppolRecord({
          number: "invalid",
          seller: sellerWithoutTaxId,
          lines: [{ description: "Work", netAmountMinor: cents(100) }],
        }),
    ],
    [
      "buyer DIČ",
      () =>
        peppolRecord({
          number: "invalid",
          buyer: buyerWithoutTaxId,
          lines: [{ description: "Work", netAmountMinor: cents(100) }],
        }),
    ],
    [
      "seller IBAN",
      () =>
        peppolRecord({
          number: "invalid",
          seller: sellerWithoutIban,
          lines: [{ description: "Work", netAmountMinor: cents(100) }],
        }),
    ],
    [
      "EUR",
      () =>
        peppolRecord({
          number: "invalid",
          currency: "CZK",
          lines: [{ description: "Work", netAmountMinor: cents(100) }],
        }),
    ],
    [
      "advance invoices",
      () =>
        peppolRecord({
          number: "invalid",
          documentType: "advance",
          lines: [{ description: "Work", netAmountMinor: cents(100) }],
        }),
    ],
    [
      "cannot be mixed",
      () =>
        peppolRecord({
          number: "invalid",
          lines: [
            {
              description: "Outside",
              netAmountMinor: cents(100),
              vatTreatment: "outside_scope" as const,
            },
            { description: "VAT", netAmountMinor: cents(100) },
          ],
        }),
    ],
    [
      "non-VAT-payer",
      () =>
        peppolRecord({
          number: "invalid",
          seller: sellerWithoutVatId,
          lines: [{ description: "Work", netAmountMinor: cents(100) }],
        }),
    ],
    [
      "buyer name is required",
      () =>
        peppolRecord({
          number: "invalid",
          buyer: { ...buyer, name: "" },
          lines: [{ description: "Work", netAmountMinor: cents(100) }],
        }),
    ],
    [
      "buyer country is required",
      () =>
        peppolRecord({
          number: "invalid",
          buyer: buyerWithoutCountry,
          lines: [{ description: "Work", netAmountMinor: cents(100) }],
        }),
    ],
    [
      "needs the buyer's IČ DPH or IČO",
      () =>
        peppolRecord({
          number: "invalid",
          buyer: buyerWithoutIdentifiers,
          lines: [
            {
              description: "Reverse charge",
              netAmountMinor: cents(100),
              vatTreatment: "reverse_charge" as const,
            },
          ],
        }),
    ],
    [
      "seller IČO",
      () =>
        peppolRecord({
          number: "invalid",
          seller: sellerWithoutRegistration,
          lines: [
            {
              description: "Outside the scope",
              netAmountMinor: cents(100),
              vatTreatment: "outside_scope" as const,
            },
          ],
        }),
    ],
    [
      "covers buyers in Slovakia",
      () =>
        peppolRecord({
          number: "invalid",
          buyer: { ...buyer, country: "DE", vatId: "DE123456789" },
          lines: [{ description: "Work", netAmountMinor: cents(100) }],
        }),
    ],
    [
      "different exemption bases",
      () =>
        peppolRecord({
          number: "invalid",
          lines: [
            {
              description: "Exempt one",
              netAmountMinor: cents(100),
              vatTreatment: "exempt" as const,
              exemptionReason: "§ 37",
            },
            {
              description: "Exempt two",
              netAmountMinor: cents(100),
              vatTreatment: "exempt" as const,
              exemptionReason: "§ 39",
            },
          ],
        }),
    ],
    ["at least one line", () => peppolRecord({ number: "invalid", lines: [] })],
    [
      "only for sellers in Slovakia",
      () =>
        peppolRecord({
          number: "invalid",
          seller: { ...seller, country: "CZ" },
          lines: [{ description: "Work", netAmountMinor: cents(100) }],
        }),
    ],
  ];

  test.each(invalidRecords)(
    "refuses invalid input: %s",
    (message, makeRecord) => {
      const record = makeRecord();
      const result = buildPeppolSkFiles([record]);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain(message);
      }
    },
  );

  test("carries the due date at document level only, as Peppol BIS expects", () => {
    const xml = contentOf(
      peppolRecord({
        number: "2027-010",
        lines: [{ description: "Work", netAmountMinor: cents(100) }],
      }),
    );
    expect(xml).toContain("<cbc:DueDate>");
    expect(xml).not.toContain("<cbc:PaymentDueDate>");
  });

  test("exports a supply taxed at the pre-2025 20 % rate and its correction", () => {
    const invoice = contentOf(
      peppolRecord({
        number: "2024-090",
        lines: [
          {
            description: "Advice in 2024",
            netAmountMinor: cents(10_000),
            vatRateBps: 2000,
          },
        ],
      }),
    );
    expect(invoice).toContain("<cbc:Percent>20</cbc:Percent>");
    const credit = contentOf(
      peppolRecord({
        number: "2027-CN-001",
        documentType: "credit_note",
        originalNumber: "2024-090",
        originalIssueDate: "2024-12-10",
        dueDate: null,
        lines: [
          {
            description: "Correction of 2024 advice",
            netAmountMinor: cents(-10_000),
            vatRateBps: 2000,
          },
        ],
      }),
    );
    expect(credit).toContain("<cbc:Percent>20</cbc:Percent>");
  });

  test("generated line sets keep document line totals equal at two decimals", () => {
    assertProperty(
      "generated line sets keep document line totals equal at two decimals",
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), {
          minLength: 1,
          maxLength: 20,
        }),
        (amounts) => {
          const xml = contentOf(
            peppolRecord({
              number: "property",
              lines: amounts.map((amount, index) => ({
                description: `Line ${String(index + 1)}`,
                netAmountMinor: cents(amount),
                vatRateBps: 2300,
              })),
            }),
          );
          const extensions = values(xml, "cbc:LineExtensionAmount");
          const total = extensions.at(-amounts.length - 1);
          const lineSum = extensions
            .slice(-amounts.length)
            .reduce((sum, amount) => sum + amount, 0);
          expect(total).toBeDefined();
          if (total !== undefined) {
            expect(lineSum.toFixed(2)).toBe(total.toFixed(2));
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
