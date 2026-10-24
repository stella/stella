import { describe, expect, test } from "bun:test";

import { cents } from "@stll/money";

import { INVOICE_ATTACHMENT } from "@/api/db/schema";
import {
  ATTACHED_ENTRY_LINE_VAT,
  attachedEntryLineDrafts,
  hoursQuantity,
  readInvoiceDocumentLines,
  readInvoiceTotals,
  timeEntryLineDraft,
} from "@/api/lib/billing/invoice-lines";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";

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
    }),
  ).toMatchObject({ netAmountMinor: 10_000, grossAmountMinor: 10_000 });
});

describe("attachedEntryLineDrafts", () => {
  const entry = (id: string, dateWorked: string) => ({
    id: toSafeId<"timeEntry">(id),
    dateWorked,
    billedMinutes: 60,
    rateAtEntry: cents(10_000),
    narrative: id,
    invoiceNarrative: null,
    noCharge: false,
  });
  const expense = (id: string, dateIncurred: string) => ({
    id: toSafeId<"expense">(id),
    dateIncurred,
    amount: cents(5000),
    markup: 0,
    description: id,
    invoiceDescription: null,
  });

  test("orders time entries then expenses by date, ties by id, whatever the input order", () => {
    const drafts = attachedEntryLineDrafts({
      timeEntryRows: [
        entry("00000000-0000-7000-8000-000000000003", "2025-02-12"),
        entry("00000000-0000-7000-8000-000000000002", "2025-02-03"),
        entry("00000000-0000-7000-8000-000000000004", "2024-12-31"),
        entry("00000000-0000-7000-8000-000000000001", "2025-02-03"),
      ],
      expenseRows: [
        expense("00000000-0000-7000-8000-00000000000b", "2025-02-10"),
        expense("00000000-0000-7000-8000-00000000000a", "2025-01-15"),
      ],
      vat: ATTACHED_ENTRY_LINE_VAT,
    });
    expect(drafts.map(({ description }) => description)).toEqual([
      "00000000-0000-7000-8000-000000000004",
      "00000000-0000-7000-8000-000000000001",
      "00000000-0000-7000-8000-000000000002",
      "00000000-0000-7000-8000-000000000003",
      "00000000-0000-7000-8000-00000000000a",
      "00000000-0000-7000-8000-00000000000b",
    ]);
  });
});

const storedLine = {
  description: "Drafting",
  quantity: "2.5000",
  unit: "h",
  unitPrice: cents(200_000),
  netAmount: cents(500_000),
  vatRateBps: 2100,
  vatTreatment: "domestic_vat",
  timeEntryId: null,
  expenseId: null,
  releasedAt: null,
} as const;

const invoice = {
  documentType: "invoice",
  netAmount: cents(500_000),
  totalAmount: cents(605_000),
  lines: [storedLine],
  timeEntries: [],
  expenses: [],
} as const;

describe("readInvoiceDocumentLines", () => {
  test("keeps each stored line's quantity, unit and unit price beside its amounts", () => {
    const fixedFee = {
      ...storedLine,
      description: "Court fee",
      quantity: "1.0000",
      unit: null,
      unitPrice: cents(30_000),
      netAmount: cents(30_000),
      vatRateBps: 0,
    };
    const document = readInvoiceDocumentLines({
      ...invoice,
      lines: [storedLine, fixedFee],
    });
    expect(document.lines).toEqual([
      {
        description: "Drafting",
        quantity: "2.5000",
        unit: "h",
        unitPrice: cents(200_000),
        netAmountMinor: cents(500_000),
        vatAmountMinor: cents(105_000),
        grossAmountMinor: cents(605_000),
        vatRateBps: 2100,
        vatTreatment: "domestic_vat",
        timeEntryId: null,
        expenseId: null,
      },
      {
        description: "Court fee",
        quantity: "1.0000",
        unit: null,
        unitPrice: cents(30_000),
        netAmountMinor: cents(30_000),
        vatAmountMinor: cents(0),
        grossAmountMinor: cents(30_000),
        vatRateBps: 0,
        vatTreatment: "domestic_vat",
        timeEntryId: null,
        expenseId: null,
      },
    ]);
    expect(document.totals).toEqual(
      readInvoiceTotals({ ...invoice, lines: [storedLine, fixedFee] }),
    );
  });

  test("gives the entries of an invoice from before lines their hours, rate and amount", () => {
    const timeEntryId = createSafeId<"timeEntry">();
    const linedTimeEntryId = createSafeId<"timeEntry">();
    const expenseId = createSafeId<"expense">();
    const legacy = {
      ...invoice,
      netAmount: null,
      lines: [{ ...storedLine, timeEntryId: linedTimeEntryId }],
      timeEntries: [
        {
          id: linedTimeEntryId,
          billedMinutes: 150,
          rateAtEntry: cents(200_000),
          narrative: "Already lined",
          invoiceNarrative: null,
          noCharge: false,
          invoiceAttachment: INVOICE_ATTACHMENT.CHARGED,
        },
        {
          id: timeEntryId,
          billedMinutes: 90,
          rateAtEntry: cents(300_000),
          narrative: "Hearing",
          invoiceNarrative: null,
          noCharge: false,
          invoiceAttachment: INVOICE_ATTACHMENT.CHARGED,
        },
      ],
      expenses: [
        {
          id: expenseId,
          amount: cents(10_000),
          markup: 10,
          description: "Courier",
          invoiceDescription: null,
        },
      ],
    };
    const document = readInvoiceDocumentLines(legacy);
    expect(
      document.lines.map(({ description, quantity, unit, unitPrice }) => ({
        description,
        quantity,
        unit,
        unitPrice,
      })),
    ).toEqual([
      {
        description: "Drafting",
        quantity: "2.5000",
        unit: "h",
        unitPrice: cents(200_000),
      },
      {
        description: "Hearing",
        quantity: "1.5",
        unit: "h",
        unitPrice: cents(300_000),
      },
      {
        description: "Courier",
        quantity: "1",
        unit: null,
        unitPrice: cents(11_000),
      },
    ]);
    expect(document.lines.map((line) => line.netAmountMinor)).toEqual([
      cents(500_000),
      cents(450_000),
      cents(11_000),
    ]);
    // Lines the read adds keep the entry they bill.
    expect(
      document.lines.map((line) => [line.timeEntryId, line.expenseId]),
    ).toEqual([
      [linedTimeEntryId, null],
      [timeEntryId, null],
      [null, expenseId],
    ]);
    expect(document.totals).toEqual(readInvoiceTotals(legacy));
  });

  test("prints a stored total without lines as one line with no quantity or unit price", () => {
    const document = readInvoiceDocumentLines({
      ...invoice,
      netAmount: null,
      totalAmount: cents(12_345),
      lines: [],
    });
    expect(document.lines).toEqual([
      {
        description: "-",
        quantity: null,
        unit: null,
        unitPrice: null,
        netAmountMinor: cents(12_345),
        vatAmountMinor: cents(0),
        grossAmountMinor: cents(12_345),
        vatRateBps: 0,
        vatTreatment: "domestic_vat",
        timeEntryId: null,
        expenseId: null,
      },
    ]);
  });

  test("an invoice without lines or a stored total prints no line", () => {
    const document = readInvoiceDocumentLines({
      ...invoice,
      netAmount: null,
      totalAmount: cents(0),
      lines: [],
    });
    expect(document.lines).toEqual([]);
  });

  test("a credit note's unit price and amounts are negative whatever sign was stored", () => {
    for (const sign of [1, -1]) {
      const document = readInvoiceDocumentLines({
        ...invoice,
        documentType: "credit_note",
        lines: [
          {
            ...storedLine,
            unitPrice: cents(sign * 200_000),
            netAmount: cents(sign * 500_000),
          },
        ],
      });
      expect(document.lines).toMatchObject([
        {
          quantity: "2.5000",
          unitPrice: cents(-200_000),
          netAmountMinor: cents(-500_000),
          vatAmountMinor: cents(-105_000),
          grossAmountMinor: cents(-605_000),
        },
      ]);
    }
  });

  test("a free line keeps a zero unit price rather than a negative zero", () => {
    const document = readInvoiceDocumentLines({
      ...invoice,
      documentType: "credit_note",
      lines: [{ ...storedLine, unitPrice: cents(0), netAmount: cents(0) }],
    });
    expect(Object.is(document.lines.at(0)?.unitPrice, 0)).toBe(true);
  });
});
