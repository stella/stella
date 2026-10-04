import { describe, expect, test } from "bun:test";

import { cents } from "@stll/money";

import { INVOICE_ATTACHMENT } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";

import {
  ATTACHED_ENTRY_LINE_VAT,
  hoursQuantity,
  readInvoiceTotals,
  timeEntryLineDraft,
} from "./invoice-lines";

describe("hoursQuantity", () => {
  test.each([
    [0, "0"],
    [60, "1"],
    [600, "10"],
    [90, "1.5"],
    [606, "10.1"],
    [6, "0.1"],
    [3, "0.05"],
    [10, "0.1667"],
    [1, "0.0167"],
  ])("%p billed minutes are %p hours", (minutes, hours) => {
    expect(hoursQuantity(minutes)).toBe(hours);
  });
});

test("legacy invoice totals and entry line drafts use the same no-charge disposition", () => {
  const entry = {
    id: createSafeId<"timeEntry">(),
    billedMinutes: 60,
    rateAtEntry: cents(10_000),
    narrative: "Work",
    invoiceNarrative: "Courtesy work",
    noCharge: true,
    invoiceAttachment: INVOICE_ATTACHMENT.CHARGED,
  };
  expect(timeEntryLineDraft(entry, ATTACHED_ENTRY_LINE_VAT)).toMatchObject({
    quantity: "1",
    description: "Courtesy work",
    unitPrice: 0,
    netAmount: 0,
  });
  expect(
    readInvoiceTotals({
      documentType: "invoice",
      netAmount: null,
      totalAmount: cents(20_000),
      lines: [],
      timeEntries: [
        entry,
        { ...entry, id: createSafeId<"timeEntry">(), noCharge: false },
      ],
      expenses: [],
    }).unwrap(),
  ).toMatchObject({ netAmountMinor: 10_000, grossAmountMinor: 10_000 });
});
