import { panic, Result } from "better-result";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import type { InvoicePaymentMethod } from "@stll/api-contract";
import { currencyMinorUnitDigits, toMajorUnits } from "@stll/money";
import { Temporal, todayFor } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  INVOICE_PAYMENT_ORIGIN,
  INVOICE_STATUS,
  INVOICE_STATUSES,
  invoicePayments,
} from "@/api/db/schema";
import type { InvoiceStatus } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockInvoiceInStatus,
  lockOriginalInvoice,
} from "@/api/lib/db/aggregate-lock";
import { outerColumnReference } from "@/api/lib/db/outer-column-reference";
import { readBounded } from "@/api/lib/db/read-bounded";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transition } from "@/api/lib/db/transitions";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import type { CentsAmount } from "@/api/lib/money";
import { readOrganizationTimeZone } from "@/api/lib/organization-time-zone";

/**
 * The owner of invoice payments: every payment write, the amount still due,
 * and the rule that an invoice is paid (settled) exactly when its non-voided
 * payments and its issued credit notes together reach its total.
 *
 * Payments are recorded on an issued invoice, finalized or sent: firms often
 * send invoices outside stella. Reaching the total marks it paid from either;
 * voiding a payment or a credit note that takes a paid invoice back below its
 * total returns it to sent when it was ever marked sent (`invoices.sentAt`),
 * else to finalized. A draft has no issued total, and a void invoice is no
 * longer owed.
 *
 * Every write takes the invoice aggregate lock (`lockInvoiceInStatus`) before
 * it reads the paid sum, so two concurrent payments are serialized and the
 * second sees the first: together they can never pay more than the total.
 */

/**
 * What a document settles: the amount owed on an invoice, the refund owed on
 * a credit note (whose total is negative). Payments are always positive.
 */
const payableAmount = (totalAmount: number) => Math.abs(totalAmount);

declare const amountDueBrand: unique symbol;

/**
 * What a client may still pay on a document: its payable total less the
 * credit notes issued against it and the payments recorded on it. Only
 * `invoiceAmountDue` makes one, so every client-facing payment request (the
 * PDF payment block, the link page with its QR code, the email) states the
 * amount `invoicePaymentAmounts` reports as outstanding, never the total.
 */
export type AmountDue = CentsAmount & { readonly [amountDueBrand]: true };

const isAmountDue = (_amount: CentsAmount): _amount is AmountDue => true;

type InvoiceBalanceInput = {
  totalAmount: number;
  paidAmount: number;
  /**
   * What issued credit notes take off the original
   * (`invoiceCreditedAmountSql`); a credit note is never credited itself.
   */
  creditedAmount: number;
};

const outstandingOf = ({
  totalAmount,
  paidAmount,
  creditedAmount,
}: InvoiceBalanceInput) =>
  cents(Math.max(0, payableAmount(totalAmount) - creditedAmount - paidAmount));

/** The amount a client may still pay, for documents and messages sent to them. */
export const invoiceAmountDue = (balance: InvoiceBalanceInput): AmountDue => {
  const outstanding = outstandingOf(balance);
  return isAmountDue(outstanding)
    ? outstanding
    : panic("Outstanding amounts are amounts due");
};

/** The plain minor-unit amount of an amount due, for API responses. */
export const amountDueCents = (amount: AmountDue): CentsAmount => amount;

/**
 * How an issued document stands, from its payments and the credit notes
 * issued against it. Only payments make it `paid`: a document its credit
 * notes cover alone is `credited`, with no payment and no payment date, so a
 * credit can never be counted, exported or shown as money received.
 * `overpaid` is a document whose payments exceed what the credit notes leave
 * of it; the client is owed `refundAmount`.
 */
export type InvoiceSettlement =
  | { kind: "open" }
  | { kind: "paid" }
  | { kind: "credited" }
  | { kind: "overpaid"; refundAmount: CentsAmount };

type InvoiceSettlementInput = InvoiceBalanceInput & { status: InvoiceStatus };

/** The settlement of one document; see `InvoiceSettlement`. */
export const invoiceSettlement = ({
  totalAmount,
  paidAmount,
  creditedAmount,
  status,
}: InvoiceSettlementInput): InvoiceSettlement => {
  const payable = payableAmount(totalAmount);
  const remaining = Math.max(0, payable - creditedAmount);
  if (paidAmount > remaining) {
    return { kind: "overpaid", refundAmount: cents(paidAmount - remaining) };
  }
  if (
    status === INVOICE_STATUS.PAID &&
    paidAmount === 0 &&
    creditedAmount === 0
  ) {
    // Settled without a payment row: a zero document once sent, or one
    // marked paid before payments were recorded (until its backfill).
    return { kind: "paid" };
  }
  if (payable === 0) {
    return { kind: "open" };
  }
  if (remaining === 0) {
    return { kind: "credited" };
  }
  return paidAmount === remaining ? { kind: "paid" } : { kind: "open" };
};

/** The paid and outstanding amounts and the settlement an invoice read exposes. */
export const invoicePaymentAmounts = (balance: InvoiceSettlementInput) => ({
  paidAmount: cents(balance.paidAmount),
  outstandingAmount: outstandingOf(balance),
  settlement: invoiceSettlement(balance),
});

/** Credit note statuses that count against their original: issued, not draft or void. */
const ISSUED_CREDIT_NOTE_STATUSES = [
  INVOICE_STATUS.FINALIZED,
  INVOICE_STATUS.SENT,
  INVOICE_STATUS.PAID,
] as const satisfies readonly InvoiceStatus[];

const creditedAmountSql = (invoiceId: SQLWrapper, organizationId: SQLWrapper) =>
  sql<number>`(SELECT COALESCE(SUM(ABS(credit_note.total_amount)), 0) FROM public.invoices credit_note WHERE credit_note.original_invoice_id = ${invoiceId} AND credit_note.organization_id = ${organizationId} AND credit_note.document_type = 'credit_note' AND credit_note.status IN (${sql.join(
    ISSUED_CREDIT_NOTE_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  )}))::bigint`.mapWith(Number);

/**
 * What the issued credit notes of the outer invoice row take off it. Credit
 * notes are read through their own row security, which shows every credit
 * note of an original the caller can see: a credit note bills only matters
 * its original bills.
 */
export const invoiceCreditedAmountSql = (table: {
  id: SQLWrapper;
  organizationId: SQLWrapper;
}) =>
  creditedAmountSql(
    outerColumnReference(table.id),
    outerColumnReference(table.organizationId),
  );

/** The same amount as a relational-query extra, whose table is already aliased. */
export const INVOICE_CREDITED_AMOUNT_EXTRA = {
  creditedAmount: (table: { id: SQLWrapper; organizationId: SQLWrapper }) =>
    creditedAmountSql(table.id, table.organizationId),
} as const;

/** The sum of the non-voided payments among an invoice's loaded payments. */
export const paidAmountOf = (
  payments: readonly { amount: number; voidedAt: Date | null }[],
) => {
  let paid = 0;
  for (const payment of payments) {
    if (payment.voidedAt === null) {
      paid += payment.amount;
    }
  }
  return paid;
};

/**
 * The paid sum of the outer invoice row, for list projections. Payments are
 * read through their own row security, which admits them only with the
 * invoice the caller can already see.
 */
export const invoicePaidAmountSql = (table: { id: SQLWrapper }) =>
  sql<number>`(SELECT COALESCE(SUM(paid_payment.amount), 0) FROM public.invoice_payments paid_payment WHERE paid_payment.invoice_id = ${outerColumnReference(table.id)} AND paid_payment.voided_at IS NULL)::bigint`.mapWith(
    Number,
  );

/** The columns every payment read returns. */
const INVOICE_PAYMENT_SELECTION = {
  id: invoicePayments.id,
  invoiceId: invoicePayments.invoiceId,
  amount: invoicePayments.amount,
  paidOn: invoicePayments.paidOn,
  method: invoicePayments.method,
  reference: invoicePayments.reference,
  note: invoicePayments.note,
  recordedBy: invoicePayments.recordedBy,
  createdAt: invoicePayments.createdAt,
  voidedAt: invoicePayments.voidedAt,
  voidedBy: invoicePayments.voidedBy,
} as const;

/** The same columns for a relational read (`with: { payments }`). */
export const INVOICE_PAYMENT_COLUMNS = {
  id: true,
  invoiceId: true,
  amount: true,
  paidOn: true,
  method: true,
  reference: true,
  note: true,
  recordedBy: true,
  createdAt: true,
  voidedAt: true,
  voidedBy: true,
} as const satisfies Record<keyof typeof INVOICE_PAYMENT_SELECTION, true>;

type StoredPayment = Pick<
  typeof invoicePayments.$inferSelect,
  keyof typeof INVOICE_PAYMENT_SELECTION
>;

/** A payment as the API returns it. */
export const invoicePaymentView = (payment: StoredPayment) => ({
  id: payment.id,
  invoiceId: payment.invoiceId,
  amount: payment.amount,
  paidOn: payment.paidOn,
  method: payment.method,
  reference: payment.reference,
  note: payment.note,
  recordedBy: payment.recordedBy,
  createdAt: payment.createdAt.toISOString(),
  voidedAt: payment.voidedAt?.toISOString() ?? null,
  voidedBy: payment.voidedBy,
});

/** Oldest payment first, the order a statement of account reads. */
export const INVOICE_PAYMENT_ORDER = {
  paidOn: "asc",
  createdAt: "asc",
  id: "asc",
} as const;

/** Every payment of one invoice, voided ones included, oldest first. */
export const readInvoicePayments = async (
  tx: Transaction,
  invoiceId: SafeId<"invoice">,
) => {
  const read = await readBounded(
    tx
      .select(INVOICE_PAYMENT_SELECTION)
      .from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, invoiceId))
      .orderBy(
        asc(invoicePayments.paidOn),
        asc(invoicePayments.createdAt),
        asc(invoicePayments.id),
      ),
    LIMITS.invoicePaymentsPerInvoice,
  );
  if (read.type === "overflow") {
    return panic("Invoice payment count exceeds its enforced limit", {
      invoiceId,
    });
  }
  return read.rows;
};

type SettlementAmounts = { paidAmount: number; creditedAmount: number };

/** The paid sum and the issued credit of one invoice, in one statement. */
const readSettlementAmounts = async (
  tx: Transaction,
  {
    invoiceId,
    organizationId,
  }: {
    invoiceId: SafeId<"invoice">;
    organizationId: SafeId<"organization">;
  },
): Promise<SettlementAmounts> => {
  const rows = await tx
    .select({
      paid: sql<string>`coalesce(sum(${invoicePayments.amount}), 0)`,
      credited: creditedAmountSql(sql`${invoiceId}`, sql`${organizationId}`),
    })
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.invoiceId, invoiceId),
        isNull(invoicePayments.voidedAt),
      ),
    );
  const row =
    rows.at(0) ?? panic("Invoice settlement aggregate returned no row");
  return {
    paidAmount: parseIntegerToken(row.paid, { sign: "unsigned" }).unwrap(
      "Invoice payment sum must be a safe nonnegative integer",
    ),
    creditedAmount: row.credited,
  };
};

/** Whether an invoice still carries a payment that has not been voided. */
export const hasActiveInvoicePayments = async (
  tx: Transaction,
  invoiceId: SafeId<"invoice">,
) =>
  (
    await tx
      .select({ id: invoicePayments.id })
      .from(invoicePayments)
      .where(
        and(
          eq(invoicePayments.invoiceId, invoiceId),
          isNull(invoicePayments.voidedAt),
        ),
      )
      .limit(1)
  ).length > 0;

const refusedStatus = (status: InvoiceStatus): HandlerError | null => {
  switch (status) {
    case INVOICE_STATUS.DRAFT:
      return new HandlerError({
        status: 409,
        message: "A draft invoice cannot take payments",
        hint: "Finalize the invoice, then record the payment.",
      });
    case INVOICE_STATUS.VOID:
      return new HandlerError({
        status: 409,
        message: "A void invoice cannot take payments",
      });
    case INVOICE_STATUS.PAID:
      return new HandlerError({
        status: 409,
        message: "This invoice is already paid; nothing is outstanding",
        hint: "To correct its payments, void the wrong payment first; that reopens the invoice for a new one.",
      });
    case INVOICE_STATUS.FINALIZED:
    case INVOICE_STATUS.SENT:
      return null;
    default:
      status satisfies never;
      return panic("Unknown invoice status");
  }
};

const majorAmountText = (amountCents: number, currency: string) =>
  `${toMajorUnits({ amountCents, currency }).toFixed(currencyMinorUnitDigits(currency))} ${currency}`;

const invoiceNotFound = () =>
  new HandlerError({ status: 404, message: "Invoice not found" });

type InvoicePaymentScope = {
  invoiceId: SafeId<"invoice">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  now: Date;
  recordAuditEvent: AuditRecorder;
};

type InvoiceSettlementScope = Pick<
  InvoicePaymentScope,
  "invoiceId" | "now" | "recordAuditEvent" | "organizationId" | "userId"
>;

type InvoicePaymentInput = {
  amount: number;
  paidOn: string;
  method: InvoicePaymentMethod;
  reference: string | null;
  note: string | null;
};

type LockedInvoice = {
  status: InvoiceStatus;
  sentAt: Date | null;
  totalAmount: number;
};

/**
 * The status an invoice's settlement decides, from the status it holds: paid
 * once its payments cover what issued credit notes leave of it (or exceed
 * it), and back to the issued status it had (sent if it was ever marked
 * sent, else finalized) once no longer covered. A document its credit notes
 * cover alone keeps its issued status: the stored status and `paidAt` record
 * money received, and its settlement (`credited`) says nothing is due.
 */
const settledStatus = (
  invoice: LockedInvoice,
  { paidAmount, creditedAmount }: SettlementAmounts,
): InvoiceStatus => {
  // What the credit notes leave of it; only payments cover that remainder.
  const remaining = Math.max(
    0,
    payableAmount(invoice.totalAmount) - creditedAmount,
  );
  const settled =
    invoice.totalAmount === 0
      ? invoice.status === INVOICE_STATUS.SENT ||
        invoice.status === INVOICE_STATUS.PAID
      : paidAmount > 0 && paidAmount >= remaining;
  const issued =
    invoice.status === INVOICE_STATUS.FINALIZED ||
    invoice.status === INVOICE_STATUS.SENT;
  if (issued && settled) {
    return INVOICE_STATUS.PAID;
  }
  if (invoice.status === INVOICE_STATUS.PAID && !settled) {
    return invoice.sentAt === null
      ? INVOICE_STATUS.FINALIZED
      : INVOICE_STATUS.SENT;
  }
  return invoice.status;
};

/**
 * Moves the locked invoice between sent and paid when its paid sum crossed
 * the total, recording the status change with the payment that caused it.
 */
const recordSettlement =
  (scope: InvoiceSettlementScope, previous: InvoiceStatus) =>
  async (tx: Transaction, row: { status: InvoiceStatus }) => {
    await scope.recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
      resourceId: scope.invoiceId,
      changes: { status: { old: previous, new: row.status } },
    });
  };

/** The one write that moves an invoice into or out of paid. */
const moveInvoiceStatus = async (
  tx: Transaction,
  {
    scope,
    invoice,
    to,
    recordTransitionAuditEvent,
  }: {
    scope: InvoiceSettlementScope;
    invoice: LockedInvoice;
    to: InvoiceStatus;
    recordTransitionAuditEvent: ReturnType<typeof recordSettlement>;
  },
) => {
  if (to === INVOICE_STATUS.PAID) {
    return await transition({
      tx,
      spec: TRANSITIONS.invoices,
      effectContext: {
        organizationId: scope.organizationId,
        actorUserId: scope.userId,
        now: scope.now,
        recordAuditEvent: scope.recordAuditEvent,
      },
      id: scope.invoiceId,
      options: {
        from: [INVOICE_STATUS.FINALIZED, INVOICE_STATUS.SENT],
        to: INVOICE_STATUS.PAID,
        set: {
          paidAt: scope.now,
          updatedAt: scope.now,
          sentAt:
            invoice.sentAt ??
            (invoice.status === INVOICE_STATUS.SENT ? scope.now : null),
        },
      },
      recordTransitionAuditEvent,
    });
  }
  if (to === INVOICE_STATUS.SENT) {
    return await transition({
      tx,
      spec: TRANSITIONS.invoices,
      effectContext: {
        organizationId: scope.organizationId,
        actorUserId: scope.userId,
        now: scope.now,
        recordAuditEvent: scope.recordAuditEvent,
      },
      id: scope.invoiceId,
      options: {
        from: [INVOICE_STATUS.PAID],
        to: INVOICE_STATUS.SENT,
        set: { paidAt: null, updatedAt: scope.now },
      },
      recordTransitionAuditEvent,
    });
  }
  if (to === INVOICE_STATUS.FINALIZED) {
    return await transition({
      tx,
      spec: TRANSITIONS.invoices,
      effectContext: {
        organizationId: scope.organizationId,
        actorUserId: scope.userId,
        now: scope.now,
        recordAuditEvent: scope.recordAuditEvent,
      },
      id: scope.invoiceId,
      options: {
        from: [INVOICE_STATUS.PAID],
        to: INVOICE_STATUS.FINALIZED,
        set: { paidAt: null, updatedAt: scope.now },
      },
      recordTransitionAuditEvent,
    });
  }
  return panic("Payments move an invoice only into or out of paid");
};

const settleStatus = async (
  tx: Transaction,
  {
    scope,
    invoice,
    amounts,
  }: {
    scope: InvoiceSettlementScope;
    invoice: LockedInvoice;
    amounts: SettlementAmounts;
  },
): Promise<Result<InvoiceStatus, HandlerError>> => {
  const { status } = invoice;
  const next = settledStatus(invoice, amounts);
  if (next === status) {
    return Result.ok(status);
  }
  const moved = await moveInvoiceStatus(tx, {
    scope,
    invoice,
    to: next,
    recordTransitionAuditEvent: recordSettlement(scope, status),
  });
  // The invoice row is locked, so its status cannot have moved meanwhile.
  return moved.type === "transitioned"
    ? Result.ok(moved.row.status)
    : Result.err(
        new HandlerError({
          status: 409,
          message: "The invoice changed while the payment was recorded",
          hint: "Reload the invoice and try again.",
        }),
      );
};

const SETTLEABLE_STATUSES: ReadonlySet<InvoiceStatus> = new Set([
  INVOICE_STATUS.FINALIZED,
  INVOICE_STATUS.SENT,
  INVOICE_STATUS.PAID,
]);

/**
 * Re-decides an original invoice's status after one of its credit notes was
 * issued, voided or reverted to draft, under the original's row lock: the
 * credit taken off it changed, so it may now be settled or open again.
 */
export const settleCreditedInvoice = async (
  tx: Transaction,
  {
    scope,
    workspaceId,
  }: {
    scope: InvoiceSettlementScope;
    workspaceId: SafeId<"workspace">;
  },
): Promise<Result<InvoiceStatus | null, HandlerError>> => {
  const original = (
    await lockOriginalInvoice(tx, { invoiceId: scope.invoiceId, workspaceId })
  ).at(0);
  if (
    original === undefined ||
    original.documentType === "credit_note" ||
    !SETTLEABLE_STATUSES.has(original.status)
  ) {
    return Result.ok(original?.status ?? null);
  }
  return await settleStatus(tx, {
    scope,
    invoice: original,
    amounts: await readSettlementAmounts(tx, scope),
  });
};

/** Settles a sent invoice under the send transition's existing aggregate lock. */
export const settleSentInvoice = async (
  tx: Transaction,
  { scope, invoice }: { scope: InvoiceSettlementScope; invoice: LockedInvoice },
) =>
  await settleStatus(tx, {
    scope,
    invoice: {
      status: INVOICE_STATUS.SENT,
      sentAt: scope.now,
      totalAmount: invoice.totalAmount,
    },
    amounts: await readSettlementAmounts(tx, scope),
  });

/**
 * Records one payment on a finalized or sent invoice and marks it paid when
 * the payment settles it. Refuses a draft or void invoice, a payment dated after
 * today in the organization's time zone, and any payment above what is still
 * outstanding.
 */
export const recordInvoicePayment = async (
  tx: Transaction,
  scope: InvoicePaymentScope,
  input: InvoicePaymentInput,
): Promise<Result<StoredPayment, HandlerError>> => {
  const timeZone = await readOrganizationTimeZone(tx, scope.organizationId);
  const today = todayFor(
    timeZone,
    Temporal.Instant.fromEpochMilliseconds(scope.now.getTime()),
  );
  if (
    Temporal.PlainDate.compare(Temporal.PlainDate.from(input.paidOn), today) > 0
  ) {
    return Result.err(
      new HandlerError({
        status: 422,
        message: "A payment cannot be dated in the future",
        hint: `Use the date the payment was received, ${today.toString()} or earlier.`,
      }),
    );
  }
  const invoice = await lockInvoiceInStatus(tx, {
    invoiceId: scope.invoiceId,
    workspaceId: scope.workspaceId,
    status: INVOICE_STATUSES,
    matterLocks: { type: "acquire" },
  });
  if (!invoice) {
    return Result.err(invoiceNotFound());
  }
  const refusal = refusedStatus(invoice.status);
  if (refusal !== null) {
    return Result.err(refusal);
  }
  const count = await tx.$count(
    invoicePayments,
    eq(invoicePayments.invoiceId, scope.invoiceId),
  );
  if (count >= LIMITS.invoicePaymentsPerInvoice) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `An invoice holds at most ${LIMITS.invoicePaymentsPerInvoice} payments`,
      }),
    );
  }
  const { paidAmount: paidBefore, creditedAmount } =
    await readSettlementAmounts(tx, scope);
  const outstandingAmount = invoiceAmountDue({
    totalAmount: invoice.totalAmount,
    paidAmount: paidBefore,
    creditedAmount,
  });
  if (outstandingAmount === 0) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "This invoice has nothing outstanding",
      }),
    );
  }
  if (input.amount > outstandingAmount) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "The payment is more than the invoice's outstanding amount",
        hint: `${majorAmountText(outstandingAmount, invoice.currency)} is outstanding; record that amount or less.`,
      }),
    );
  }
  const [payment] = await tx
    .insert(invoicePayments)
    .values({
      organizationId: scope.organizationId,
      invoiceId: scope.invoiceId,
      amount: cents(input.amount),
      origin: INVOICE_PAYMENT_ORIGIN.RECORDED,
      paidOn: input.paidOn,
      method: input.method,
      reference: input.reference,
      note: input.note,
      recordedBy: scope.userId,
      createdAt: scope.now,
    })
    .returning();
  if (!payment) {
    return Result.err(invoiceNotFound());
  }
  const paidAfter = paidBefore + input.amount;
  await scope.recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
    resourceId: scope.invoiceId,
    changes: {
      payment: { old: null, new: payment.id },
      paidAmount: { old: paidBefore, new: paidAfter },
    },
  });
  const settled = await settleStatus(tx, {
    scope,
    invoice,
    amounts: { paidAmount: paidAfter, creditedAmount },
  });
  return settled.isErr() ? Result.err(settled.error) : Result.ok(payment);
};

/**
 * Voids one payment, keeping its row as the record, and returns a paid
 * invoice that is no longer covered to the issued status it had.
 */
export const voidInvoicePayment = async (
  tx: Transaction,
  scope: InvoicePaymentScope,
  paymentId: SafeId<"invoicePayment">,
): Promise<Result<StoredPayment, HandlerError>> => {
  const invoice = await lockInvoiceInStatus(tx, {
    invoiceId: scope.invoiceId,
    workspaceId: scope.workspaceId,
    status: INVOICE_STATUSES,
    matterLocks: { type: "acquire" },
  });
  if (!invoice) {
    return Result.err(invoiceNotFound());
  }
  const { paidAmount: paidBefore, creditedAmount } =
    await readSettlementAmounts(tx, scope);
  const [payment] = await tx
    .update(invoicePayments)
    .set({ voidedAt: scope.now, voidedBy: scope.userId })
    .where(
      and(
        eq(invoicePayments.id, paymentId),
        eq(invoicePayments.invoiceId, scope.invoiceId),
        isNull(invoicePayments.voidedAt),
      ),
    )
    .returning();
  if (!payment) {
    return Result.err(
      new HandlerError({
        status: 404,
        message: "Payment not found or already voided",
      }),
    );
  }
  const paidAfter = paidBefore - payment.amount;
  await scope.recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
    resourceId: scope.invoiceId,
    changes: {
      voidedPayment: { old: null, new: payment.id },
      paidAmount: { old: paidBefore, new: paidAfter },
    },
  });
  const settled = await settleStatus(tx, {
    scope,
    invoice,
    amounts: { paidAmount: paidAfter, creditedAmount },
  });
  return settled.isErr() ? Result.err(settled.error) : Result.ok(payment);
};
