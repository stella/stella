import { Result } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
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
/**
 * The selected expenses that are still offered. A refresh drops an expense
 * billed elsewhere meanwhile, so its stale selection is never submitted.
 */
export const includedExpenseIdsOf = (
  expenses: readonly ComposerExpense[],
  includedExpenseIds: ReadonlySet<string>,
): string[] =>
  expenses
    .filter((expense) => includedExpenseIds.has(expense.id))
    .map((expense) => expense.id);

/**
 * The currencies the billable items are recorded in, the one with the largest
 * unbilled amount first. An invoice has one currency, so these are the
 * invoices the items can go on. Equal amounts keep the order the matters list
 * their items in, so the first matter's currency wins a tie.
 */
export const billableCurrencies = (
  prefills: readonly {
    timeEntries: readonly ComposerEntry[];
    expenses: readonly ComposerExpense[];
  }[],
): string[] => {
  const amounts = new Map<string, number>();
  const add = (currency: string, amount: number) =>
    amounts.set(currency, (amounts.get(currency) ?? 0) + amount);
  for (const { timeEntries, expenses } of prefills) {
    for (const entry of timeEntries) {
      add(entry.currency, entryAmount(entry, initialEntryChoice(entry)));
    }
    for (const expense of expenses) {
      add(expense.currency, expenseAmount(expense));
    }
  }
  return [...amounts]
    .toSorted(([, left], [, right]) => right - left)
    .map(([currency]) => currency);
};

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
/**
 * Billed hours as editable text that `parseHoursInput` reads back unchanged:
 * the locale's decimal separator, but Latin digits and no grouping, so
 * "1,000" hours never re-parses as one hour and Arabic-Indic digits never
 * revert an edit.
 */
export const editableHoursText = (minutes: number, locale: string) =>
  new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
    numberingSystem: "latn",
    useGrouping: false,
  }).format(minutes / 60);

export const parseHoursInput = (text: string): number | null => {
  const match = HOURS_PATTERN.exec(text.trim());
  const whole = match?.groups?.["whole"];
  if (whole === undefined) {
    return null;
  }
  const fraction = match?.groups?.["fraction"] ?? "";
  const wholeHours = parseIntegerToken(whole, { sign: "unsigned" }).unwrap(
    "Hours grammar admits at most four decimal digits",
  );
  const fractionalHours = parseIntegerToken(fraction.padEnd(4, "0"), {
    sign: "unsigned",
  }).unwrap("Hours grammar admits at most four fractional decimal digits");
  const hundredThousandths = wholeHours * 10_000 + fractionalHours;
  return Math.round((hundredThousandths * 60) / 10_000);
};

/** The issue date plus a payment term, as an ISO date. */
/**
 * What a client invoice states from the composed body: everything a matter
 * invoice states except its sources, which the client invoice groups per
 * matter. Removing only those keeps every other detail (language, dates,
 * seller) on both paths.
 */
export const clientInvoiceDetails = <
  TBody extends {
    timeEntryIds?: unknown;
    expenseIds?: unknown;
    entryAdjustments?: unknown;
    documentType?: unknown;
    originalInvoiceId?: unknown;
    invoiceNumber?: unknown;
  },
>({
  timeEntryIds: _timeEntryIds,
  expenseIds: _expenseIds,
  entryAdjustments: _entryAdjustments,
  documentType: _documentType,
  originalInvoiceId: _originalInvoiceId,
  invoiceNumber: _invoiceNumber,
  ...details
}: TBody) => details;

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
 * Creates the draft, then issues it when asked and reads it back. Once the
 * draft exists the composer is done with it: a failed issue or read returns
 * `savedDraft` instead of failing, so the person opens the saved draft rather
 * than submitting the composer again, which would create a second invoice or
 * leave later edits unsaved.
 */
export const submitComposedInvoice = async <
  TCreated extends { id: string },
  TInvoice,
>({
  issue,
  create,
  finalize,
  read,
  savedDraft,
}: {
  issue: boolean;
  create: () => Promise<TCreated>;
  finalize: (id: string) => Promise<void>;
  read: (id: string) => Promise<TInvoice>;
  savedDraft: (created: TCreated, error: unknown) => TInvoice;
}): Promise<TInvoice> => {
  const created = await create();
  const result = await Result.tryPromise({
    try: async () => {
      if (issue) {
        await finalize(created.id);
      }
      return await read(created.id);
    },
    catch: (cause) => cause,
  });
  return Result.isError(result)
    ? savedDraft(created, result.error)
    : result.value;
};
