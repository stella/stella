import { calculateDocumentTotals, standardVatRateOn } from "@stll/invoicing";
import type {
  InvoiceTotals,
  VatRatePeriod,
  VatTreatment,
} from "@stll/invoicing";
import { applyMarkupCents, cents, timeEntryAmount } from "@stll/money";
import type { CentsAmount } from "@stll/money";
import { parsePlainDate } from "@stll/time";

/** A time entry the composer can bill, as `invoices.prefill` returns it. */
export type ComposerEntry = {
  id: string;
  dateWorked: string;
  billedMinutes: number;
  rateAtEntry: number;
  noCharge: boolean;
  currency: string;
};

/** An expense the composer can bill, as `invoices.prefill` returns it. */
export type ComposerExpense = {
  id: string;
  dateIncurred: string;
  amount: number;
  markup: number;
  currency: string;
};

/** What the person decided for one entry. Absent means "as recorded". */
export type EntryChoice = {
  included: boolean;
  billedMinutes: number;
  noCharge: boolean;
};

type ComposerVat = {
  vatTreatment: VatTreatment;
  vatRateBps: number;
};

const initialEntryChoice = (entry: ComposerEntry): EntryChoice => ({
  included: true,
  billedMinutes: entry.billedMinutes,
  noCharge: entry.noCharge,
});

export const entryChoice = (
  choices: ReadonlyMap<string, EntryChoice>,
  entry: ComposerEntry,
): EntryChoice => choices.get(entry.id) ?? initialEntryChoice(entry);

/** The amount an entry bills with the person's choices applied. */
export const entryAmount = (
  entry: ComposerEntry,
  choice: EntryChoice,
): CentsAmount =>
  timeEntryAmount({
    billedMinutes: choice.billedMinutes,
    rateAtEntry: cents(entry.rateAtEntry),
    noCharge: choice.noCharge,
  });

export const expenseAmount = (expense: ComposerExpense): CentsAmount =>
  applyMarkupCents({
    amountCents: cents(expense.amount),
    markupPercent: expense.markup,
  });

type ComposeOptions = {
  entries: readonly ComposerEntry[];
  choices: ReadonlyMap<string, EntryChoice>;
  expenses: readonly ComposerExpense[];
  includedExpenseIds: ReadonlySet<string>;
  vat: ComposerVat;
  /** A flat-fee matter bills its agreed fee as the only line. */
  flatFeeAmount?: number | null;
};

/**
 * The totals the draft will have, from the same calculation the API runs on
 * its lines (`calculateDocumentTotals`, one line per entry and expense), so the
 * composer and the issued invoice agree to the minor unit.
 */
export const composeTotals = ({
  entries,
  choices,
  expenses,
  includedExpenseIds,
  vat,
  flatFeeAmount = null,
}: ComposeOptions): InvoiceTotals | null => {
  const amounts = flatFeeAmount === null ? null : [cents(flatFeeAmount)];
  const lines = (
    amounts ?? [
      ...entries
        .map((entry) => ({ entry, choice: entryChoice(choices, entry) }))
        .filter(({ choice }) => choice.included)
        .map(({ entry, choice }) => entryAmount(entry, choice)),
      ...expenses
        .filter((expense) => includedExpenseIds.has(expense.id))
        .map(expenseAmount),
    ]
  ).map((netAmountMinor) => ({
    description: "-",
    netAmountMinor,
    ...vat,
  }));
  const calculated = calculateDocumentTotals({
    documentType: "invoice",
    lines,
  });
  return calculated.isOk() ? calculated.value.totals : null;
};

/**
 * Whether the invoice has anything to bill: a flat-fee matter always bills
 * its agreed fee, with or without entries; otherwise at least one included
 * entry or expense.
 */
export const hasBillableItems = ({
  flatFeeAmount,
  includedEntryCount,
  includedExpenseCount,
}: {
  flatFeeAmount: number | null;
  includedEntryCount: number;
  includedExpenseCount: number;
}) =>
  flatFeeAmount !== null || includedEntryCount > 0 || includedExpenseCount > 0;

/** Billed minutes of the included entries. */
export const includedMinutes = (
  entries: readonly ComposerEntry[],
  choices: ReadonlyMap<string, EntryChoice>,
) => {
  let total = 0;
  for (const entry of entries) {
    const choice = entryChoice(choices, entry);
    if (choice.included) {
      total += choice.billedMinutes;
    }
  }
  return total;
};

/** The last day any included work happened: the taxable supply date. */
export const lastIncludedWorkDate = ({
  entries,
  choices,
  expenses,
  includedExpenseIds,
}: Omit<ComposeOptions, "vat" | "flatFeeAmount">): string | null => {
  let latest: string | null = null;
  const dates = [
    ...entries
      .filter((entry) => entryChoice(choices, entry).included)
      .map((entry) => entry.dateWorked),
    ...expenses
      .filter((expense) => includedExpenseIds.has(expense.id))
      .map((expense) => expense.dateIncurred),
  ];
  for (const date of dates) {
    if (latest === null || date > latest) {
      latest = date;
    }
  }
  return latest;
};

/** The adjustments to send: only entries whose billing the person changed. */
export const entryAdjustments = (
  entries: readonly ComposerEntry[],
  choices: ReadonlyMap<string, EntryChoice>,
) =>
  entries.flatMap((entry) => {
    const choice = choices.get(entry.id);
    if (
      choice === undefined ||
      !choice.included ||
      (choice.billedMinutes === entry.billedMinutes &&
        choice.noCharge === entry.noCharge)
    ) {
      return [];
    }
    return [
      {
        timeEntryId: entry.id,
        billedMinutes: choice.billedMinutes,
        noCharge: choice.noCharge,
      },
    ];
  });

const HOURS_PATTERN = /^(?<whole>\d{1,4})(?:[.,](?<fraction>\d{1,4}))?$/u;

/**
 * Minutes for hours a person typed ("1.5", "1,25", "2"), rounded to the
 * minute, or null when the text is not a number of hours.
 */
export const parseHoursInput = (text: string): number | null => {
  const match = HOURS_PATTERN.exec(text.trim());
  const whole = match?.groups?.["whole"];
  if (whole === undefined) {
    return null;
  }
  const fraction = match?.groups?.["fraction"] ?? "";
  const hundredThousandths =
    Number(whole) * 10_000 + Number(fraction.padEnd(4, "0") || "0");
  return Math.round((hundredThousandths * 60) / 10_000);
};

/** The issue date plus a payment term, as an ISO date. */
export const dueDateFor = (invoiceDate: string, days: number) =>
  parsePlainDate(invoiceDate)?.add({ days }).toString() ?? null;

export type ComposerVatDecision<TReason extends string> = {
  vatTreatment: VatTreatment;
  vatRateBps: number;
  reason: TReason;
};

/**
 * The prefill's VAT decision re-resolved for the supply date of the current
 * selection: billing fewer items can move that date into another rate period.
 * Only a domestic rate depends on the date, and the rule matches the server's.
 */
export const vatOnSupplyDate = <TReason extends string>(
  vat: ComposerVatDecision<TReason>,
  periods: readonly VatRatePeriod[],
  supplyDate: string,
): ComposerVatDecision<TReason | "no_vat_rate" | "domestic_rate"> => {
  if (
    vat.vatTreatment !== "domestic_vat" ||
    vat.reason === "no_seller_profile"
  ) {
    return vat;
  }
  const rateBps = standardVatRateOn(periods, supplyDate);
  if (rateBps === null) {
    return {
      vatTreatment: "domestic_vat",
      vatRateBps: 0,
      reason: "no_vat_rate",
    };
  }
  return {
    vatTreatment: "domestic_vat",
    vatRateBps: rateBps,
    reason: vat.reason === "no_vat_rate" ? "domestic_rate" : vat.reason,
  };
};

/**
 * Creates the draft at most once, then issues it when asked and reads it
 * back. `draftId` is the draft an earlier attempt already created: a retry
 * after a failed issue or read continues with that draft instead of creating
 * a second invoice, which matters for a flat fee where no claimed entry would
 * refuse the duplicate.
 */
export const submitComposedInvoice = async <TInvoice>({
  draftId,
  issue,
  create,
  onCreated,
  finalize,
  read,
}: {
  draftId: string | null;
  issue: boolean;
  create: () => Promise<{ id: string }>;
  onCreated: (id: string) => void;
  finalize: (id: string) => Promise<void>;
  read: (id: string) => Promise<TInvoice>;
}): Promise<TInvoice> => {
  let id = draftId;
  if (id === null) {
    id = (await create()).id;
    onCreated(id);
  }
  if (issue) {
    await finalize(id);
  }
  return read(id);
};
