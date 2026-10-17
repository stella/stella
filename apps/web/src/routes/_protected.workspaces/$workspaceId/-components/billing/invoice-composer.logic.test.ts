import { describe, expect, test } from "bun:test";

import {
  composeTotals,
  dueDateFor,
  editableHoursText,
  entryAdjustments,
  hasBillableItems,
  includedExpenseIdsOf,
  lastIncludedWorkDate,
  parseHoursInput,
  submitComposedInvoice,
  vatOnSupplyDate,
} from "./invoice-composer.logic";
import type {
  ComposerEntry,
  ComposerExpense,
  EntryChoice,
} from "./invoice-composer.logic";

const entries: ComposerEntry[] = [
  {
    id: "a",
    dateWorked: "2026-09-02",
    billedMinutes: 90,
    rateAtEntry: 250_000,
    noCharge: false,
    currency: "CZK",
  },
  {
    id: "b",
    dateWorked: "2026-09-30",
    billedMinutes: 30,
    rateAtEntry: 180_000,
    noCharge: false,
    currency: "CZK",
  },
];
const expenses: ComposerExpense[] = [
  {
    id: "x",
    dateIncurred: "2026-09-11",
    amount: 60_000,
    markup: 0,
    currency: "CZK",
  },
];
const vat = { vatTreatment: "domestic_vat", vatRateBps: 2100 } as const;

describe("invoice composer totals", () => {
  test("price every included entry and expense with per-line VAT", () => {
    const totals = composeTotals({
      entries,
      choices: new Map(),
      expenses,
      includedExpenseIds: new Set(["x"]),
      vat,
    });
    // 375,000 + 90,000 + 60,000 net; VAT 78,750 + 18,900 + 12,600.
    expect(totals).toMatchObject({
      netAmountMinor: 525_000,
      vatAmountMinor: 110_250,
      grossAmountMinor: 635_250,
    });
  });

  test("excluded, written-down and no-charge entries change the total", () => {
    const choices = new Map<string, EntryChoice>([
      ["a", { included: true, billedMinutes: 60, noCharge: false }],
      ["b", { included: false, billedMinutes: 30, noCharge: false }],
    ]);
    expect(
      composeTotals({
        entries,
        choices,
        expenses,
        includedExpenseIds: new Set(),
        vat: { vatTreatment: "not_vat_payer", vatRateBps: 0 },
      }),
    ).toMatchObject({ netAmountMinor: 250_000, vatAmountMinor: 0 });
    choices.set("a", { included: true, billedMinutes: 60, noCharge: true });
    expect(
      composeTotals({
        entries,
        choices,
        expenses,
        includedExpenseIds: new Set(),
        vat,
      }),
    ).toMatchObject({ grossAmountMinor: 0 });
  });

  test("the supply date follows the included work", () => {
    const choices = new Map<string, EntryChoice>([
      ["b", { included: false, billedMinutes: 30, noCharge: false }],
    ]);
    expect(
      lastIncludedWorkDate({
        entries,
        choices,
        expenses,
        includedExpenseIds: new Set(["x"]),
      }),
    ).toBe("2026-09-11");
    expect(
      lastIncludedWorkDate({
        entries: [],
        choices,
        expenses,
        includedExpenseIds: new Set(),
      }),
    ).toBeNull();
  });
});

describe("invoice composer request", () => {
  test("sends only entries whose billing changed", () => {
    const choices = new Map<string, EntryChoice>([
      ["a", { included: true, billedMinutes: 90, noCharge: false }],
      ["b", { included: true, billedMinutes: 15, noCharge: false }],
    ]);
    expect(entryAdjustments(entries, choices)).toEqual([
      { timeEntryId: "b", billedMinutes: 15, noCharge: false },
    ]);
  });

  test.each([
    ["1.5", 90],
    ["1,25", 75],
    ["2", 120],
    [" 0.1 ", 6],
    ["0", 0],
  ])("reads %p hours as %p minutes", (text, minutes) => {
    expect(parseHoursInput(text)).toBe(minutes);
  });

  test.each(["", "-1", "1.5h", "abc", "1.23456"])(
    "refuses %p as hours",
    (text) => {
      expect(parseHoursInput(text)).toBeNull();
    },
  );

  test("the due date adds the term to the issue date", () => {
    expect(dueDateFor("2026-10-12", 14)).toBe("2026-10-26");
    expect(dueDateFor("2026-12-20", 30)).toBe("2027-01-19");
  });
});

describe("flat-fee invoices", () => {
  test("bill the agreed fee as the only line, with or without entries", () => {
    expect(
      composeTotals({
        entries: [],
        choices: new Map(),
        expenses: [],
        includedExpenseIds: new Set(),
        vat,
        flatFeeAmount: 1_000_000,
      }),
    ).toMatchObject({
      netAmountMinor: 1_000_000,
      vatAmountMinor: 210_000,
      grossAmountMinor: 1_210_000,
    });
    expect(
      composeTotals({
        entries,
        choices: new Map(),
        expenses,
        includedExpenseIds: new Set(["x"]),
        vat,
        flatFeeAmount: 1_000_000,
      }),
    ).toMatchObject({ netAmountMinor: 1_000_000 });
  });

  test("a fee-only invoice can be issued; an hourly one needs an item", () => {
    expect(
      hasBillableItems({
        flatFeeAmount: 1_000_000,
        includedEntryCount: 0,
        includedExpenseCount: 0,
      }),
    ).toBe(true);
    expect(
      hasBillableItems({
        flatFeeAmount: null,
        includedEntryCount: 0,
        includedExpenseCount: 0,
      }),
    ).toBe(false);
    expect(
      hasBillableItems({
        flatFeeAmount: null,
        includedEntryCount: 0,
        includedExpenseCount: 1,
      }),
    ).toBe(true);
  });
});

describe("VAT for the selected work", () => {
  const periods = [
    { validFrom: "2020-01-01", validTo: "2026-09-20", rateBps: 2100 },
    { validFrom: "2026-09-20", validTo: null, rateBps: 2300 },
  ];
  const domestic = {
    vatTreatment: "domestic_vat",
    vatRateBps: 2300,
    reason: "domestic_rate",
  } as const;

  test("re-resolves a domestic rate when the supply date moves before a change", () => {
    expect(vatOnSupplyDate(domestic, periods, "2026-09-02")).toEqual({
      ...domestic,
      vatRateBps: 2100,
    });
    expect(vatOnSupplyDate(domestic, periods, "2026-09-30")).toEqual(domestic);
  });

  test("keeps a rate that does not depend on the date", () => {
    const reverse = {
      vatTreatment: "reverse_charge",
      vatRateBps: 0,
      reason: "reverse_charge",
    } as const;
    expect(vatOnSupplyDate(reverse, periods, "2026-09-02")).toEqual(reverse);
  });

  test("reports no rate before the first period", () => {
    expect(vatOnSupplyDate(domestic, periods, "2019-06-01")).toEqual({
      vatTreatment: "domestic_vat",
      vatRateBps: 0,
      reason: "no_vat_rate",
    });
  });
});

describe("submitComposedInvoice", () => {
  const submit = ({
    issue,
    readFails,
  }: {
    issue: boolean;
    readFails: boolean;
  }) => {
    const calls: string[] = [];
    const result = submitComposedInvoice({
      issue,
      create: async () => {
        calls.push("create");
        return { id: "inv-1" };
      },
      finalize: async (id) => {
        calls.push(`finalize:${id}`);
      },
      read: async (id) => {
        calls.push(`read:${id}`);
        if (readFails) {
          throw new Error("read failed");
        }
        return `issued ${id}`;
      },
      savedDraft: (created) => `draft ${created.id}`,
    });
    return { calls, result };
  };

  test("creates, issues and reads the invoice back", async () => {
    const attempt = submit({ issue: true, readFails: false });
    expect(await attempt.result).toBe("issued inv-1");
    expect(attempt.calls).toEqual(["create", "finalize:inv-1", "read:inv-1"]);
  });

  test("a failed read after the draft was saved ends on that draft instead of failing", async () => {
    const attempt = submit({ issue: true, readFails: true });
    expect(await attempt.result).toBe("draft inv-1");
    expect(attempt.calls).toEqual(["create", "finalize:inv-1", "read:inv-1"]);
  });

  test("saving a draft does not issue it", async () => {
    const attempt = submit({ issue: false, readFails: false });
    expect(await attempt.result).toBe("issued inv-1");
    expect(attempt.calls).toEqual(["create", "read:inv-1"]);
  });
});

describe("includedExpenseIdsOf", () => {
  test("drops a selected expense that a refresh no longer offers", () => {
    // "x" is still offered; "billed-elsewhere" left the refreshed prefill.
    expect(
      includedExpenseIdsOf(expenses, new Set(["x", "billed-elsewhere"])),
    ).toEqual(["x"]);
  });
});

describe("editableHoursText", () => {
  test.each([
    ["en", 60_000, "1000"],
    ["en", 90, "1.5"],
    ["cs", 90, "1,5"],
    ["ar", 90, "1.5"],
  ])(
    "%s %d minutes edit as %s and read back unchanged",
    (locale, minutes, text) => {
      expect(editableHoursText(minutes, locale)).toBe(text);
      expect(parseHoursInput(text)).toBe(minutes);
    },
  );
});
