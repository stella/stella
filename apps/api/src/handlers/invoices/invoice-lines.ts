import { panic, Result } from "better-result";
import { and, asc, eq, isNull, max, notExists } from "drizzle-orm";
import { type Static, t } from "elysia";

import {
  INVOICE_LINE_SOURCE,
  type InvoiceLineSource,
} from "@stll/api-contract";
import {
  calculateDocumentTotals,
  calculateLineNetAmount,
} from "@stll/invoicing";
import type {
  InvoiceDocumentType,
  InvoiceLineInput,
  InvoiceTotals,
  VatTreatment,
} from "@stll/invoicing";
import { applyMarkupCents, timeEntryAmount } from "@stll/money";

import type { Transaction } from "@/api/db/root";
import {
  expenses,
  INVOICE_ATTACHMENT,
  INVOICE_BILLING_PURPOSE,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import { validateInvoiceDocument } from "@/api/handlers/invoices/document-type";
import { lockInvoiceInStatus } from "@/api/handlers/invoices/lock-invoice";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  type AuditRecorder,
  type FieldDiffs,
} from "@/api/lib/audit-log";
import { recordBillingCapCrossings } from "@/api/lib/billing/arrangements";
import { checkInvoiceBillingArrangement } from "@/api/lib/billing/invoice-arrangements";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { cents, type CentsAmount } from "@/api/lib/money";
import type {
  UnprojectedColumns,
  UnbackedProjectionKeys,
} from "@/api/lib/projection-totality";

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
// treatment would reset it to `domestic_vat`. The members are a tuple, not a
// `.map()` result: a union over a plain array has the static type `never`.
export const tVatTreatment = t.Union([
  t.Literal("domestic_vat"),
  t.Literal("not_vat_payer"),
  t.Literal("reverse_charge"),
  t.Literal("exempt"),
]);

true satisfies [VatTreatment] extends [Static<typeof tVatTreatment>]
  ? [Static<typeof tVatTreatment>] extends [VatTreatment]
    ? true
    : never
  : never;

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
  billingPurpose: (typeof invoiceLines.$inferSelect)["billingPurpose"];
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
    .replace(/(?<!0)0+$/u, "");
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
  noCharge: boolean;
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
  unitPrice: entry.noCharge ? cents(0) : entry.rateAtEntry,
  netAmount: timeEntryAmount(entry),
  ...vat,
  source: INVOICE_LINE_SOURCE.TIME_ENTRY,
  billingPurpose: INVOICE_BILLING_PURPOSE.ORDINARY,
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
    billingPurpose: INVOICE_BILLING_PURPOSE.ORDINARY,
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
    billingPurpose: INVOICE_BILLING_PURPOSE.ORDINARY,
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
  netAmountMinor: cents(Math.abs(line.netAmount)),
  vatRateBps: line.vatRateBps,
  vatTreatment: line.vatTreatment,
});

/** VAT and gross of each line, from `calculateDocumentTotals`. */
export const priceLines = (
  drafts: readonly InvoiceLineDraft[],
  documentType: InvoiceDocumentType = "invoice",
): Result<PricedLine[], HandlerError> => {
  const calculated = calculateDocumentTotals({
    documentType,
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
      netAmount: line.netAmountMinor,
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
 * Appends priced lines after the invoice's last position and records them on
 * the invoice's audit trail (ids, sources and amounts, never descriptions,
 * which can quote privileged work). The caller holds the invoice row lock
 * (`lockInvoiceInStatus`), which serializes positions. Drafts come from the
 * builders above, whose amounts are already validated, so pricing them cannot
 * fail.
 */
export const insertInvoiceLines = async (
  tx: Transaction,
  scope: InvoiceScope,
  drafts: readonly InvoiceLineDraft[],
  audit: {
    recordAuditEvent: AuditRecorder;
    metadata?: Record<string, unknown>;
  },
): Promise<{ id: SafeId<"invoiceLine">; source: InvoiceLineSource }[]> => {
  const { recordAuditEvent, metadata } = audit;
  if (drafts.length === 0) {
    return [];
  }
  const invoice = await tx.query.invoices.findFirst({
    where: {
      id: { eq: scope.invoiceId },
      workspaceId: { eq: scope.workspaceId },
    },
    columns: { documentType: true },
  });
  if (!invoice) {
    return panic("The locked invoice disappeared before line insertion");
  }
  const priced = priceLines(drafts, invoice.documentType);
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
  const inserted = await tx
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
        billingPurpose: line.billingPurpose,
        timeEntryId: line.timeEntryId,
        expenseId: line.expenseId,
      })),
    )
    .returning({
      id: invoiceLines.id,
      source: invoiceLines.source,
      netAmount: invoiceLines.netAmount,
      vatRateBps: invoiceLines.vatRateBps,
    });
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
    resourceId: scope.invoiceId,
    changes: { linesAdded: { old: null, new: inserted } },
    ...(metadata ? { metadata } : {}),
  });
  return inserted.map(({ id, source }) => ({ id, source }));
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
 * An invoice holds at most `LIMITS.invoiceLinesPerInvoice` lines, so one read
 * past that bound finds every attached entry a draft can bill; one insert of
 * that many lines (16 bound columns each) stays far below the 65,535-parameter
 * cap.
 */
const MATERIALISE_LIMIT = LIMITS.invoiceLinesPerInvoice + 1;

/**
 * Drafts created before invoice lines existed carry attached time entries and
 * expenses but no lines, and their stored total is the sum of those entries.
 * Totals now come from lines alone, so a line edit on such a draft would
 * silently drop the entries from the total. This gives every attached entry
 * without an unreleased line the line create-from-entries would have written
 * (same builders, same 0 % VAT), appended after existing lines: time entries
 * by date then id, then expenses the same way. An entry that already holds an
 * unreleased line (here, or anywhere the partial unique indexes would refuse
 * a second one) is skipped, so a second call writes nothing.
 * Runs in the caller's transaction under the invoice row lock; returns how
 * many lines it wrote. Its lines are audited as backfilled.
 */
const materialiseAttachedEntryLines = async (
  tx: Transaction,
  scope: InvoiceScope,
  recordAuditEvent: AuditRecorder,
): Promise<number> => {
  const unlinedTimeEntries = () =>
    tx
      .select({
        id: timeEntries.id,
        billedMinutes: timeEntries.billedMinutes,
        rateAtEntry: timeEntries.rateAtEntry,
        narrative: timeEntries.narrative,
        invoiceNarrative: timeEntries.invoiceNarrative,
        noCharge: timeEntries.noCharge,
      })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.invoiceId, scope.invoiceId),
          eq(timeEntries.invoiceAttachment, INVOICE_ATTACHMENT.CHARGED),
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
      .limit(MATERIALISE_LIMIT);
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
      .limit(MATERIALISE_LIMIT);

  const [unlinedEntries, unlinedExpenseRows] = await Promise.all([
    unlinedTimeEntries(),
    unlinedExpenses(),
  ]);
  const missing = unlinedEntries.length + unlinedExpenseRows.length;
  if (missing > LIMITS.invoiceLinesPerInvoice) {
    return panic(
      `Invoice ${scope.invoiceId} has more attached entries than an invoice holds lines`,
    );
  }
  await insertInvoiceLines(
    tx,
    scope,
    [
      ...unlinedEntries.map((entry) =>
        timeEntryLineDraft(entry, ATTACHED_ENTRY_LINE_VAT),
      ),
      ...unlinedExpenseRows.map((expense) =>
        expenseLineDraft(expense, ATTACHED_ENTRY_LINE_VAT),
      ),
    ],
    { recordAuditEvent, metadata: { materialisedFromAttachedEntries: true } },
  );
  return missing;
};

/**
 * Locks a draft invoice before its lines change and backfills lines for
 * entries attached before lines existed (`materialiseAttachedEntryLines`), so
 * the edit and the `recalculateInvoiceTotals` after it see every billed
 * entry. Backfilled lines are totalled at once, so the invoice stays
 * consistent before the requested change. Every handler
 * that changes a draft's lines locks through here; returns an empty success when
 * the invoice is missing or not a draft.
 *
 * Reads do not call this: a read never writes, so a legacy draft lists no
 * lines for its attached entries until its first line edit materialises
 * them, and its read totals count those entries in memory
 * (`readInvoiceTotals`).
 */
export const lockDraftInvoiceForLines = async (
  tx: Transaction,
  scope: InvoiceScope,
  recordAuditEvent: AuditRecorder,
) => {
  const invoice = await lockInvoiceInStatus(tx, {
    invoiceId: scope.invoiceId,
    workspaceId: scope.workspaceId,
    status: INVOICE_STATUS.DRAFT,
  });
  if (
    invoice &&
    (await materialiseAttachedEntryLines(tx, scope, recordAuditEvent)) > 0
  ) {
    const totals = await recalculateInvoiceTotals(
      tx,
      scope,
      new Date(),
      recordAuditEvent,
    );
    if (totals.isErr()) {
      return Result.err(totals.error);
    }
  }
  return Result.ok(invoice);
};

type InvoiceEntryChangeLockOptions = InvoiceScope & {
  recordAuditEvent: AuditRecorder;
  conflictMessage: string;
};

export const requireDraftInvoiceForEntryChanges = async (
  tx: Transaction,
  {
    recordAuditEvent,
    conflictMessage,
    ...scope
  }: InvoiceEntryChangeLockOptions,
) => {
  const result = await lockDraftInvoiceForLines(tx, scope, recordAuditEvent);
  if (result.isErr()) {
    return Result.err(result.error);
  }
  if (!result.value) {
    return Result.err(
      new HandlerError({ status: 409, message: conflictMessage }),
    );
  }
  return Result.ok(result.value);
};

const calculateInvoiceAmounts = (
  lines: readonly LineAmountInput[],
  documentType: InvoiceDocumentType,
) =>
  calculateDocumentTotals({
    documentType,
    lines: lines.map(toLineInput),
  }).mapError(
    (error) => new HandlerError({ status: 500, message: error.message }),
  );

/** Invoice totals and VAT breakdown over the given lines. */
const invoiceTotals = (
  lines: readonly LineAmountInput[],
  documentType: InvoiceDocumentType = "invoice",
): Result<InvoiceTotals, HandlerError> =>
  calculateInvoiceAmounts(lines, documentType).map(({ totals }) => totals);

type InvoiceForReadTotals = {
  documentType: InvoiceDocumentType;
  /** NULL marks totals written before invoice lines existed. */
  netAmount: CentsAmount | null;
  totalAmount: CentsAmount;
  lines: readonly (LineAmountInput & {
    timeEntryId: SafeId<"timeEntry"> | null;
    expenseId: SafeId<"expense"> | null;
    releasedAt: Date | null;
  })[];
  timeEntries: readonly (TimeEntryForLine &
    Pick<typeof timeEntries.$inferSelect, "invoiceAttachment">)[];
  expenses: readonly ExpenseForLine[];
};

type LineQuantity = {
  quantity: string;
  unit: string | null;
  unitPrice: CentsAmount;
};

type InvoiceSourceLine = LineAmountInput & Partial<LineQuantity>;

/**
 * The lines an invoice read counts. An invoice with stored totals (`netAmount`
 * set) has exactly its stored lines. One from before invoice lines
 * (`netAmount` NULL) also has, in memory, the line each attached entry without
 * one would get (the drafts `materialiseAttachedEntryLines` writes on the next
 * line edit); a voided one of those has released its entries, so its stored
 * total stands as one net line at 0 % VAT, which is how totals were written
 * before lines. That line alone carries no quantity or unit price.
 */
const readInvoiceSourceLines = (
  invoice: InvoiceForReadTotals,
): InvoiceSourceLine[] => {
  if (invoice.netAmount !== null) {
    return [...invoice.lines];
  }
  const linedTimeEntries = new Set<string>();
  const linedExpenses = new Set<string>();
  for (const line of invoice.lines) {
    if (line.releasedAt !== null) {
      continue;
    }
    if (line.timeEntryId !== null) {
      linedTimeEntries.add(line.timeEntryId);
    }
    if (line.expenseId !== null) {
      linedExpenses.add(line.expenseId);
    }
  }
  const lines: InvoiceSourceLine[] = [
    ...invoice.lines,
    ...invoice.timeEntries
      .filter(
        (entry) =>
          entry.invoiceAttachment === INVOICE_ATTACHMENT.CHARGED &&
          !linedTimeEntries.has(entry.id),
      )
      .map((entry) => timeEntryLineDraft(entry, ATTACHED_ENTRY_LINE_VAT)),
    ...invoice.expenses
      .filter((expense) => !linedExpenses.has(expense.id))
      .map((expense) => expenseLineDraft(expense, ATTACHED_ENTRY_LINE_VAT)),
  ];
  if (lines.length === 0 && invoice.totalAmount !== 0) {
    lines.push({
      description: "-",
      netAmount: invoice.totalAmount,
      ...ATTACHED_ENTRY_LINE_VAT,
    });
  }
  return lines;
};

/** Totals for an invoice read, which never writes. */
const readInvoiceAmounts = (invoice: InvoiceForReadTotals) =>
  calculateInvoiceAmounts(
    readInvoiceSourceLines(invoice),
    invoice.documentType,
  );

type InvoiceForDocumentLines = Omit<InvoiceForReadTotals, "lines"> & {
  lines: readonly (InvoiceForReadTotals["lines"][number] & LineQuantity)[];
};

/**
 * The lines an invoice document prints, each with its calculated amounts and
 * the quantity, unit and unit price it was billed at, plus the totals over
 * them. The unit price carries the document's sign, so quantity times unit
 * price has the sign of the line's net amount on a credit note too.
 */
export const readInvoiceDocumentLines = (invoice: InvoiceForDocumentLines) => {
  const source = readInvoiceSourceLines(invoice);
  const sign = invoice.documentType === "credit_note" ? -1 : 1;
  return calculateInvoiceAmounts(source, invoice.documentType).map(
    ({ lines, totals }) => ({
      lines: lines.map((line, index) => {
        const billed =
          source[index] ?? panic("A calculated line has no source line");
        return {
          ...line,
          quantity: billed.quantity ?? null,
          unit: billed.unit ?? null,
          unitPrice:
            billed.unitPrice === undefined
              ? null
              : cents(sign * Math.abs(billed.unitPrice) || 0),
        };
      }),
      totals,
    }),
  );
};

export const readInvoiceTotals = (invoice: InvoiceForReadTotals) =>
  readInvoiceAmounts(invoice).map(({ totals }) => totals);

/**
 * Recomputes the invoice's stored totals from all of its lines (a voided
 * invoice keeps its released lines, and its document keeps their totals).
 * It records the stored amounts that changed on the invoice's audit trail, so
 * callers record only what they changed themselves. Call inside the
 * transaction that changed the lines, after locking the invoice. Credit-note
 * limits are checked before totals are written; callers roll back any refusal.
 */
export const recalculateInvoiceTotals = async (
  tx: Transaction,
  scope: Omit<InvoiceScope, "organizationId">,
  now: Date,
  recordAuditEvent: AuditRecorder,
): Promise<Result<InvoiceTotals, HandlerError>> => {
  const billing = await checkInvoiceBillingArrangement(tx, scope);
  if (billing.isErr()) {
    return Result.err(billing.error);
  }
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
  const invoiceScope = and(
    eq(invoices.id, scope.invoiceId),
    eq(invoices.workspaceId, scope.workspaceId),
  );
  const [stored] = await tx
    .select({
      documentType: invoices.documentType,
      originalInvoiceId: invoices.originalInvoiceId,
      currency: invoices.currency,
      netAmount: invoices.netAmount,
      vatAmount: invoices.vatAmount,
      totalAmount: invoices.totalAmount,
    })
    .from(invoices)
    .where(invoiceScope);
  if (!stored) {
    return panic("The locked invoice disappeared before recalculation");
  }
  const totals = invoiceTotals(lines, stored.documentType);
  if (totals.isErr()) {
    return Result.err(totals.error);
  }
  const valid = await validateInvoiceDocument(tx, {
    invoiceId: scope.invoiceId,
    workspaceId: scope.workspaceId,
    documentType: stored.documentType,
    originalInvoiceId: stored.originalInvoiceId,
    currency: stored.currency,
    totalAmount: totals.value.grossAmountMinor,
  });
  if (valid.isErr()) {
    return Result.err(valid.error);
  }
  const next = {
    netAmount: totals.value.netAmountMinor,
    vatAmount: totals.value.vatAmountMinor,
    totalAmount: totals.value.grossAmountMinor,
  };
  await tx
    .update(invoices)
    .set({ ...next, updatedAt: now })
    .where(invoiceScope);
  const changes: FieldDiffs = {};
  for (const field of ["netAmount", "vatAmount", "totalAmount"] as const) {
    const old = stored[field] ?? null;
    if (old !== next[field]) {
      changes[field] = { old, new: next[field] };
    }
  }
  if (Object.keys(changes).length > 0) {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
      resourceId: scope.invoiceId,
      changes,
    });
  }
  await recordBillingCapCrossings(tx, {
    workspaceId: scope.workspaceId,
    recordAuditEvent,
  });
  return Result.ok(totals.value);
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
  billingPurpose: true,
  timeEntryId: true,
  expenseId: true,
  releasedAt: true,
} as const;

// Tenant and parent identifiers come from the scoped invoice detail; line
// persistence timestamps belong to audit bookkeeping, not the document line.
const INVOICE_LINE_OMITTED_COLUMNS = [
  "organizationId",
  "workspaceId",
  "invoiceId",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof typeof invoiceLines.$inferSelect)[];
type MissingInvoiceLineColumn = UnprojectedColumns<
  typeof invoiceLines.$inferSelect,
  typeof INVOICE_LINE_COLUMNS,
  (typeof INVOICE_LINE_OMITTED_COLUMNS)[number]
>;
type ExtraInvoiceLineColumn = UnbackedProjectionKeys<
  typeof invoiceLines.$inferSelect,
  typeof INVOICE_LINE_COLUMNS,
  (typeof INVOICE_LINE_OMITTED_COLUMNS)[number]
>;
true satisfies MissingInvoiceLineColumn extends never ? true : never;
true satisfies ExtraInvoiceLineColumn extends never ? true : never;
