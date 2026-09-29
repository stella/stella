import { panic, Result } from "better-result";
import { and, asc, eq, isNull, max, notExists } from "drizzle-orm";
import { t } from "elysia";

import {
  INVOICE_LINE_SOURCE,
  type InvoiceLineSource,
} from "@stll/api-contract";
import {
  calculateDocumentTotals,
  calculateLineNetAmount,
  VAT_TREATMENTS,
} from "@stll/invoicing";
import type {
  InvoiceLineInput,
  InvoiceTotals,
  VatTreatment,
} from "@stll/invoicing";
import { applyMarkupCents, prorateHourlyCents } from "@stll/money";

import type { Transaction } from "@/api/db/root";
import {
  expenses,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import { lockInvoiceInStatus } from "@/api/handlers/invoices/lock-invoice";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import type { CentsAmount } from "@/api/lib/money";

/** Stored quantity scale: `invoice_lines.quantity` is `numeric(18, 4)`. */
const QUANTITY_SCALE = 4;
const QUANTITY_FACTOR = 10 ** QUANTITY_SCALE;
const LINE_DESCRIPTION_MAX_CHARS = 10_000;

export const tInvoiceLineQuantity = t.String({
  pattern: `^(0|[1-9][0-9]{0,13})(\\.[0-9]{1,${QUANTITY_SCALE}})?$`,
  description:
    'Non-negative decimal quantity with a dot and at most four decimals, e.g. "1.5"',
});

export const tVatRateBps = t.Integer({
  minimum: 0,
  maximum: 10_000,
  description: "VAT rate in basis points: 2100 is 21 %",
});

// A literal union, not `t.UnionEnum`: Elysia coerces an absent optional
// UnionEnum field to its first member, so a line patch that omits the
// treatment would reset it to `domestic_vat`.
export const tVatTreatment = t.Union(
  VAT_TREATMENTS.map((treatment) => t.Literal(treatment)),
);

export const tLineDescription = t.String({
  minLength: 1,
  maxLength: LINE_DESCRIPTION_MAX_CHARS,
});

export const tLineUnit = t.String({ minLength: 1, maxLength: 32 });

export type LineVat = {
  vatRateBps: number;
  vatTreatment: VatTreatment;
};

/**
 * Lines created by attaching entries (invoice create with entries,
 * invoices.entries.add) carry no VAT until the caller sets the rate on the
 * line, which keeps those invoices' totals where they were.
 */
export const ATTACHED_ENTRY_LINE_VAT = {
  vatRateBps: 0,
  vatTreatment: "domestic_vat",
} as const satisfies LineVat;

export type InvoiceLineDraft = LineVat & {
  description: string;
  quantity: string;
  unit: string | null;
  unitPrice: CentsAmount;
  netAmount: CentsAmount;
  source: InvoiceLineSource;
  timeEntryId: SafeId<"timeEntry"> | null;
  expenseId: SafeId<"expense"> | null;
};

type PricedLine = InvoiceLineDraft & {
  vatAmount: CentsAmount;
  grossAmount: CentsAmount;
};

/** Hours for billed minutes, rounded half up to the stored scale. */
export const hoursQuantity = (billedMinutes: number): string => {
  const scaled = Math.floor((billedMinutes * QUANTITY_FACTOR * 2 + 60) / 120);
  const whole = Math.floor(scaled / QUANTITY_FACTOR);
  const fraction = (scaled % QUANTITY_FACTOR)
    .toString()
    .padStart(QUANTITY_SCALE, "0")
    .replace(/0+$/u, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
};

/** First non-blank candidate, bounded to what a line stores. */
const lineDescription = (...candidates: (string | null | undefined)[]) => {
  const text = candidates.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  return (text ?? "-").slice(0, LINE_DESCRIPTION_MAX_CHARS);
};

type TimeEntryForLine = {
  id: SafeId<"timeEntry">;
  billedMinutes: number;
  rateAtEntry: CentsAmount;
  narrative: string;
  invoiceNarrative: string | null;
};

/**
 * The net amount is the entry's own billed amount from its minutes, not the
 * rounded hour quantity times the rate: minutes that are not whole hundredths
 * of an hour would otherwise bill a different amount than the entry shows.
 */
export const timeEntryLineDraft = (
  entry: TimeEntryForLine,
  vat: LineVat,
  description?: string,
): InvoiceLineDraft => ({
  description: lineDescription(
    description,
    entry.invoiceNarrative,
    entry.narrative,
  ),
  quantity: hoursQuantity(entry.billedMinutes),
  unit: "h",
  unitPrice: entry.rateAtEntry,
  netAmount: prorateHourlyCents({
    billedMinutes: entry.billedMinutes,
    hourlyRateCents: entry.rateAtEntry,
  }),
  ...vat,
  source: INVOICE_LINE_SOURCE.TIME_ENTRY,
  timeEntryId: entry.id,
  expenseId: null,
});

type ExpenseForLine = {
  id: SafeId<"expense">;
  amount: CentsAmount;
  markup: number;
  description: string;
  invoiceDescription: string | null;
};

export const expenseLineDraft = (
  expense: ExpenseForLine,
  vat: LineVat,
  description?: string,
): InvoiceLineDraft => {
  const amount = applyMarkupCents({
    amountCents: expense.amount,
    markupPercent: expense.markup,
  });
  return {
    description: lineDescription(
      description,
      expense.invoiceDescription,
      expense.description,
    ),
    quantity: "1",
    unit: null,
    unitPrice: amount,
    netAmount: amount,
    ...vat,
    source: INVOICE_LINE_SOURCE.EXPENSE,
    timeEntryId: null,
    expenseId: expense.id,
  };
};

export const manualLineDraft = (
  input: LineVat & {
    description: string;
    quantity: string;
    unit: string | null;
    unitPrice: CentsAmount;
  },
): Result<InvoiceLineDraft, HandlerError> => {
  const netAmount = calculateLineNetAmount({
    quantity: input.quantity,
    unitPriceMinor: input.unitPrice,
  });
  if (netAmount.isErr()) {
    return Result.err(
      new HandlerError({ status: 400, message: netAmount.error.message }),
    );
  }
  return Result.ok({
    ...input,
    netAmount: netAmount.value,
    source: INVOICE_LINE_SOURCE.MANUAL,
    timeEntryId: null,
    expenseId: null,
  });
};

type LineAmountInput = LineVat & {
  description: string;
  netAmount: CentsAmount;
};

const toLineInput = (line: LineAmountInput): InvoiceLineInput => ({
  description: line.description,
  netAmountMinor: line.netAmount,
  vatRateBps: line.vatRateBps,
  vatTreatment: line.vatTreatment,
});

/** VAT and gross of each line, from `calculateDocumentTotals`. */
export const priceLines = (
  drafts: readonly InvoiceLineDraft[],
): Result<PricedLine[], HandlerError> => {
  const calculated = calculateDocumentTotals({
    documentType: "invoice",
    lines: drafts.map(toLineInput),
  });
  if (calculated.isErr()) {
    return Result.err(
      new HandlerError({ status: 400, message: calculated.error.message }),
    );
  }
  const priced: PricedLine[] = [];
  for (const [index, draft] of drafts.entries()) {
    const line = calculated.value.lines[index];
    if (!line) {
      return Result.err(
        new HandlerError({ status: 500, message: "Line pricing failed" }),
      );
    }
    priced.push({
      ...draft,
      vatAmount: line.vatAmountMinor,
      grossAmount: line.grossAmountMinor,
    });
  }
  return Result.ok(priced);
};

type InvoiceScope = {
  invoiceId: SafeId<"invoice">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

/**
 * Appends priced lines after the invoice's last position. The caller holds
 * the invoice row lock (`lockInvoiceInStatus`), which serializes positions.
 * Drafts come from the builders above, whose amounts are already validated,
 * so pricing them cannot fail.
 */
export const insertInvoiceLines = async (
  tx: Transaction,
  scope: InvoiceScope,
  drafts: readonly InvoiceLineDraft[],
): Promise<{ id: SafeId<"invoiceLine">; source: InvoiceLineSource }[]> => {
  if (drafts.length === 0) {
    return [];
  }
  const priced = priceLines(drafts);
  if (priced.isErr()) {
    return panic(
      `Validated invoice lines failed pricing: ${priced.error.message}`,
    );
  }
  const [last] = await tx
    .select({ position: max(invoiceLines.position) })
    .from(invoiceLines)
    .where(
      and(
        eq(invoiceLines.invoiceId, scope.invoiceId),
        eq(invoiceLines.workspaceId, scope.workspaceId),
      ),
    );
  const start = (last?.position ?? -1) + 1;
  // audit: skip - callers record the invoice event covering these lines.
  return await tx
    .insert(invoiceLines)
    .values(
      priced.value.map((line, index) => ({
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        invoiceId: scope.invoiceId,
        position: start + index,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        vatRateBps: line.vatRateBps,
        vatTreatment: line.vatTreatment,
        netAmount: line.netAmount,
        vatAmount: line.vatAmount,
        grossAmount: line.grossAmount,
        source: line.source,
        timeEntryId: line.timeEntryId,
        expenseId: line.expenseId,
      })),
    )
    .returning({ id: invoiceLines.id, source: invoiceLines.source });
};

/**
 * Refuses a change that would take an invoice past
 * `LIMITS.invoiceLinesPerInvoice` lines: a detail read returns every line.
 * Call under the invoice row lock and after `lockDraftInvoiceForLines`, so
 * the count includes lines it materialised and matches what the insert sees,
 * and before writing anything else, so a refusal leaves no partial change.
 */
export const checkInvoiceLineCapacity = async (
  tx: Transaction,
  scope: Omit<InvoiceScope, "organizationId">,
  adding: number,
): Promise<Result<void, HandlerError>> => {
  const lineCount = await tx.$count(
    invoiceLines,
    and(
      eq(invoiceLines.invoiceId, scope.invoiceId),
      eq(invoiceLines.workspaceId, scope.workspaceId),
    ),
  );
  if (lineCount + adding > LIMITS.invoiceLinesPerInvoice) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `An invoice holds at most ${LIMITS.invoiceLinesPerInvoice} lines`,
      }),
    );
  }
  return Result.ok(undefined);
};

/**
 * Entries read and lines written per round: 16 bound columns per line stays
 * far below the 65,535-parameter cap.
 */
const MATERIALISE_BATCH_SIZE = 500;

/**
 * Drafts created before invoice lines existed carry attached time entries and
 * expenses but no lines, and their stored total is the sum of those entries.
 * Totals now come from lines alone, so a line edit on such a draft would
 * silently drop the entries from the total. This gives every attached entry
 * without an unreleased line the line create-from-entries would have written
 * (same builders, same 0 % VAT), appended after existing lines: time entries
 * by date then id, then expenses the same way. An entry that already holds an
 * unreleased line (here, or anywhere the partial unique indexes would refuse
 * a second one) is skipped, so a second call writes nothing; the same filter
 * pages through large invoices, since each written round drops out of it.
 * Runs in the caller's transaction under the invoice row lock; returns how
 * many lines it wrote.
 */
const materialiseAttachedEntryLines = async (
  tx: Transaction,
  scope: InvoiceScope,
): Promise<number> => {
  const unlinedTimeEntries = () =>
    tx
      .select({
        id: timeEntries.id,
        billedMinutes: timeEntries.billedMinutes,
        rateAtEntry: timeEntries.rateAtEntry,
        narrative: timeEntries.narrative,
        invoiceNarrative: timeEntries.invoiceNarrative,
      })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.invoiceId, scope.invoiceId),
          eq(timeEntries.workspaceId, scope.workspaceId),
          notExists(
            tx
              .select({ id: invoiceLines.id })
              .from(invoiceLines)
              .where(
                and(
                  eq(invoiceLines.timeEntryId, timeEntries.id),
                  isNull(invoiceLines.releasedAt),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(timeEntries.dateWorked), asc(timeEntries.id))
      .limit(MATERIALISE_BATCH_SIZE);
  const unlinedExpenses = () =>
    tx
      .select({
        id: expenses.id,
        amount: expenses.amount,
        markup: expenses.markup,
        description: expenses.description,
        invoiceDescription: expenses.invoiceDescription,
      })
      .from(expenses)
      .where(
        and(
          eq(expenses.invoiceId, scope.invoiceId),
          eq(expenses.workspaceId, scope.workspaceId),
          notExists(
            tx
              .select({ id: invoiceLines.id })
              .from(invoiceLines)
              .where(
                and(
                  eq(invoiceLines.expenseId, expenses.id),
                  isNull(invoiceLines.releasedAt),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(expenses.dateIncurred), asc(expenses.id))
      .limit(MATERIALISE_BATCH_SIZE);

  // audit: skip - the entries were attached (and audited) before; their
  // lines restate the amount the invoice already bills.
  let written = 0;
  for (;;) {
    const batch = await unlinedTimeEntries();
    written += batch.length;
    await insertInvoiceLines(
      tx,
      scope,
      batch.map((entry) => timeEntryLineDraft(entry, ATTACHED_ENTRY_LINE_VAT)),
    );
    if (batch.length < MATERIALISE_BATCH_SIZE) {
      break;
    }
  }
  for (;;) {
    const batch = await unlinedExpenses();
    written += batch.length;
    await insertInvoiceLines(
      tx,
      scope,
      batch.map((expense) =>
        expenseLineDraft(expense, ATTACHED_ENTRY_LINE_VAT),
      ),
    );
    if (batch.length < MATERIALISE_BATCH_SIZE) {
      break;
    }
  }
  return written;
};

/**
 * Locks a draft invoice before its lines change and backfills lines for
 * entries attached before lines existed (`materialiseAttachedEntryLines`), so
 * the edit and the `recalculateInvoiceTotals` after it see every billed
 * entry. Backfilled lines are totalled at once, so the invoice stays
 * consistent even when the caller then refuses its change. Every handler
 * that changes a draft's lines locks through here; returns `undefined` when
 * the invoice is missing or not a draft.
 *
 * Reads do not call this: a read never writes, so a legacy draft reads with
 * no lines and line totals of zero while its stored `totalAmount` keeps the
 * entries' sum, until its first line edit materialises the lines.
 */
export const lockDraftInvoiceForLines = async (
  tx: Transaction,
  scope: InvoiceScope,
) => {
  const invoice = await lockInvoiceInStatus(tx, {
    invoiceId: scope.invoiceId,
    workspaceId: scope.workspaceId,
    status: INVOICE_STATUS.DRAFT,
  });
  if (invoice && (await materialiseAttachedEntryLines(tx, scope)) > 0) {
    await recalculateInvoiceTotals(tx, scope, new Date());
  }
  return invoice;
};

/** Invoice totals and VAT breakdown over stored lines. */
export const invoiceTotals = (
  lines: readonly LineAmountInput[],
): Result<InvoiceTotals, HandlerError> => {
  const calculated = calculateDocumentTotals({
    documentType: "invoice",
    lines: lines.map(toLineInput),
  });
  if (calculated.isErr()) {
    return Result.err(
      new HandlerError({ status: 500, message: calculated.error.message }),
    );
  }
  return Result.ok(calculated.value.totals);
};

/**
 * Recomputes the invoice's stored totals from all of its lines (a voided
 * invoice keeps its released lines, and its document keeps their totals).
 * Call inside the transaction that changed the lines, after locking the
 * invoice. Stored lines were priced when written, so totalling them cannot
 * fail.
 */
export const recalculateInvoiceTotals = async (
  tx: Transaction,
  scope: Omit<InvoiceScope, "organizationId">,
  now: Date,
): Promise<InvoiceTotals> => {
  const lines = await tx
    .select({
      description: invoiceLines.description,
      netAmount: invoiceLines.netAmount,
      vatRateBps: invoiceLines.vatRateBps,
      vatTreatment: invoiceLines.vatTreatment,
    })
    .from(invoiceLines)
    .where(
      and(
        eq(invoiceLines.invoiceId, scope.invoiceId),
        eq(invoiceLines.workspaceId, scope.workspaceId),
      ),
    );
  const totals = invoiceTotals(lines);
  if (totals.isErr()) {
    return panic(
      `Stored invoice lines failed totalling: ${totals.error.message}`,
    );
  }
  // audit: skip - callers record the invoice event with the new total.
  await tx
    .update(invoices)
    .set({
      netAmount: totals.value.netAmountMinor,
      vatAmount: totals.value.vatAmountMinor,
      totalAmount: totals.value.grossAmountMinor,
      updatedAt: now,
    })
    .where(
      and(
        eq(invoices.id, scope.invoiceId),
        eq(invoices.workspaceId, scope.workspaceId),
      ),
    );
  return totals.value;
};

/** Columns an invoice detail read returns for each line. */
export const INVOICE_LINE_COLUMNS = {
  id: true,
  position: true,
  description: true,
  quantity: true,
  unit: true,
  unitPrice: true,
  vatRateBps: true,
  vatTreatment: true,
  netAmount: true,
  vatAmount: true,
  grossAmount: true,
  source: true,
  timeEntryId: true,
  expenseId: true,
  releasedAt: true,
} as const;
