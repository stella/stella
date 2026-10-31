import { describe, expect, test } from "bun:test";

import { cents } from "@stll/money";

import {
  calculateDocumentTotals,
  createInvoiceDocument,
  createSingleLineDocument,
} from "./invoice-document";

describe("invoice document totals", () => {
  test("calculates Czech 21%, 12%, and 0% VAT rates", () => {
    const result = calculateDocumentTotals({
      documentType: "invoice",
      lines: [
        {
          description: "21%",
          netAmountMinor: cents(10_005),
          vatRateBps: 2100,
          vatTreatment: "domestic_vat",
        },
        {
          description: "12%",
          netAmountMinor: cents(10_005),
          vatRateBps: 1200,
          vatTreatment: "domestic_vat",
        },
        {
          description: "0%",
          netAmountMinor: cents(10_005),
          vatRateBps: 0,
          vatTreatment: "domestic_vat",
        },
      ],
    }).unwrap();

    expect(result.lines.map(({ vatAmountMinor }) => vatAmountMinor)).toEqual([
      cents(2101),
      cents(1201),
      cents(0),
    ]);
    expect(result.totals.grossAmountMinor).toBe(cents(33_317));
  });

  test("rounds VAT on each line before summing by rate", () => {
    const result = calculateDocumentTotals({
      documentType: "invoice",
      lines: [
        {
          description: "First",
          netAmountMinor: cents(1),
          vatRateBps: 5000,
          vatTreatment: "domestic_vat",
        },
        {
          description: "Second",
          netAmountMinor: cents(1),
          vatRateBps: 5000,
          vatTreatment: "domestic_vat",
        },
      ],
    }).unwrap();

    expect(result.totals).toEqual({
      netAmountMinor: cents(2),
      vatAmountMinor: cents(2),
      grossAmountMinor: cents(4),
      vatBreakdown: [
        {
          vatRateBps: 5000,
          vatTreatment: "domestic_vat",
          netAmountMinor: cents(2),
          vatAmountMinor: cents(2),
          grossAmountMinor: cents(4),
        },
      ],
    });
  });

  test("does not add VAT for reverse charge lines", () => {
    const result = calculateDocumentTotals({
      documentType: "invoice",
      lines: [
        {
          description: "Service",
          netAmountMinor: cents(50_000),
          vatRateBps: 2100,
          vatTreatment: "reverse_charge",
        },
      ],
    }).unwrap();

    expect(result.totals.grossAmountMinor).toBe(cents(50_000));
    expect(result.totals.vatAmountMinor).toBe(cents(0));
  });

  test("accepts zero lines and accumulates per-line rounding across many lines", () => {
    const result = calculateDocumentTotals({
      documentType: "invoice",
      lines: [
        {
          description: "Zero",
          netAmountMinor: cents(0),
          vatRateBps: 2100,
          vatTreatment: "domestic_vat",
        },
        ...Array.from({ length: 100 }, (_, index) => ({
          description: `Small ${index}`,
          netAmountMinor: cents(5),
          vatRateBps: 2100,
          vatTreatment: "domestic_vat" as const,
        })),
      ],
    }).unwrap();

    expect(result.totals).toMatchObject({
      netAmountMinor: cents(500),
      vatAmountMinor: cents(100),
      grossAmountMinor: cents(600),
    });
  });

  test("an advance has positive totals and a credit note reverses them", () => {
    const input = {
      number: "DOC-1",
      issueDate: "2026-04-30",
      currency: "CZK",
      seller: { name: "Seller" },
      buyer: { name: "Buyer" },
      description: "Service",
      netAmountMinor: cents(10_000),
      vatRateBps: 2100,
    };
    const advance = createSingleLineDocument({
      ...input,
      documentType: "advance",
    }).unwrap();
    const credit = createSingleLineDocument({
      ...input,
      documentType: "credit_note",
    }).unwrap();

    expect(advance.totals.grossAmountMinor).toBe(cents(12_100));
    expect(credit.totals.grossAmountMinor).toBe(cents(-12_100));
    expect(credit.lines[0]?.grossAmountMinor).toBe(cents(-12_100));
  });

  test("rejects documents without lines", () => {
    const result = createInvoiceDocument({
      documentType: "invoice",
      number: "INV-1",
      issueDate: "2026-04-30",
      currency: "CZK",
      seller: { name: "Seller" },
      buyer: { name: "Buyer" },
      lines: [],
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe(
        "Invoice document requires at least one line",
      );
    }
  });

  test("rejects a total that exceeds safe minor units", () => {
    expect(() =>
      calculateDocumentTotals({
        documentType: "invoice",
        lines: [
          {
            description: "Large",
            netAmountMinor: cents(Number.MAX_SAFE_INTEGER),
            vatRateBps: 0,
            vatTreatment: "exempt",
          },
          {
            description: "Extra",
            netAmountMinor: cents(1),
            vatRateBps: 0,
            vatTreatment: "exempt",
          },
        ],
      }),
    ).toThrow("safe integer minor units");
  });
});
