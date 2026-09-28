import { describe, expect, test } from "bun:test";

import { cents } from "@stll/money";

import {
  calculateDocumentTotals,
  createInvoiceDocument,
  createSingleLineDocument,
} from "./invoice-document";

describe("invoice document totals", () => {
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
    });

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
    });

    expect(result.totals.grossAmountMinor).toBe(cents(50_000));
    expect(result.totals.vatAmountMinor).toBe(cents(0));
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
    });
    const credit = createSingleLineDocument({
      ...input,
      documentType: "credit_note",
    });

    expect(advance.totals.grossAmountMinor).toBe(cents(12_100));
    expect(credit.totals.grossAmountMinor).toBe(cents(-12_100));
    expect(credit.lines[0]?.grossAmountMinor).toBe(cents(-12_100));
  });

  test("rejects documents without lines", () => {
    expect(() =>
      createInvoiceDocument({
        documentType: "invoice",
        number: "INV-1",
        issueDate: "2026-04-30",
        currency: "CZK",
        seller: { name: "Seller" },
        buyer: { name: "Buyer" },
        lines: [],
      }),
    ).toThrow("Invoice document requires at least one line");
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
