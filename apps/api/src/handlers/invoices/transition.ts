import { Result } from "better-result";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { type Static, t } from "elysia";

import type { Transaction } from "@/api/db/root";
import { resultTx } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  expenses,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import type { InvoiceStatus } from "@/api/db/schema";
import { lockInvoiceInStatus } from "@/api/handlers/invoices/lock-invoice";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type {
  AuditRecorder,
  AuditEvent,
  FieldDiffs,
} from "@/api/lib/audit-log";
import {
  allocateNumber,
  findDefaultNumberSeries,
} from "@/api/lib/billing/number-series";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";

import { validateInvoiceDocument } from "./document-type";
import {
  EMPTY_INVOICE_PAYMENT,
  invoicePaymentAuditChanges,
  prepareInvoicePayment,
  tMarkInvoicePaid,
  tUndoInvoicePaid,
} from "./invoice-payment";

const transitionInvoiceBodySchema = t.Union([
  tMarkInvoicePaid,
  tUndoInvoicePaid,
  t.Object(
    { action: t.UnionEnum(["finalize", "send", "void", "revert_to_draft"]) },
    { additionalProperties: false },
  ),
]);
type TransitionAction = Static<typeof transitionInvoiceBodySchema>["action"];

const TRANSITIONS = {
  finalize: {
    from: [INVOICE_STATUS.DRAFT],
    to: INVOICE_STATUS.FINALIZED,
  },
  send: {
    from: [INVOICE_STATUS.FINALIZED],
    to: INVOICE_STATUS.SENT,
  },
  mark_paid: {
    from: [INVOICE_STATUS.SENT, INVOICE_STATUS.PAID],
    to: INVOICE_STATUS.PAID,
  },
  undo_paid: {
    from: [INVOICE_STATUS.PAID, INVOICE_STATUS.SENT],
    to: INVOICE_STATUS.SENT,
  },
  void: {
    from: [INVOICE_STATUS.FINALIZED, INVOICE_STATUS.SENT, INVOICE_STATUS.PAID],
    to: INVOICE_STATUS.VOID,
  },
  revert_to_draft: {
    from: [INVOICE_STATUS.FINALIZED],
    to: INVOICE_STATUS.DRAFT,
  },
} as const satisfies Record<
  TransitionAction,
  { from: InvoiceStatus[]; to: InvoiceStatus }
>;

const invoiceParamsSchema = workspaceParams({ invoiceId: tSafeId("invoice") });

const buildVoidEvents = (params: {
  invoiceId: SafeId<"invoice">;
  previousStatus: InvoiceStatus;
  paymentChanges: FieldDiffs;
  revertedTimeEntries: { id: SafeId<"timeEntry"> }[];
  revertedExpenses: { id: SafeId<"expense"> }[];
}): AuditEvent[] => {
  const events: AuditEvent[] = [
    {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
      resourceId: params.invoiceId,
      changes: {
        status: { old: params.previousStatus, new: INVOICE_STATUS.VOID },
        ...params.paymentChanges,
      },
    },
  ];
  for (const row of params.revertedTimeEntries) {
    events.push({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
      resourceId: row.id,
      changes: {
        status: {
          old: BILLING_STATUS.BILLED,
          new: BILLING_STATUS.APPROVED,
        },
        invoiceId: { old: params.invoiceId, new: null },
      },
    });
  }
  for (const row of params.revertedExpenses) {
    events.push({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.EXPENSE,
      resourceId: row.id,
      changes: {
        status: {
          old: BILLING_STATUS.BILLED,
          new: BILLING_STATUS.APPROVED,
        },
        invoiceId: { old: params.invoiceId, new: null },
      },
    });
  }
  return events;
};

type ReleaseInvoiceEntriesOptions = {
  actorUserId: SafeId<"user">;
  invoiceId: SafeId<"invoice">;
  workspaceId: SafeId<"workspace">;
  previousStatus: InvoiceStatus;
  paymentChanges: FieldDiffs;
  now: Date;
  recordAuditEvent: AuditRecorder;
};
const releaseInvoiceEntries = async (
  tx: Transaction,
  {
    invoiceId,
    workspaceId,
    previousStatus,
    paymentChanges,
    now,
    recordAuditEvent,
    actorUserId,
  }: ReleaseInvoiceEntriesOptions,
) => {
  // The caller acquires these locks before the invoice; guard the release too.
  const runningError = await guardRunningTimeEntries({
    tx,
    workspaceId,
    actorUserId,
    selection: { type: "invoice", invoiceId },
  });
  if (runningError) {
    return Result.err(runningError);
  }
  const revertedTimeEntries = await tx
    .update(timeEntries)
    .set({
      status: BILLING_STATUS.APPROVED,
      invoiceId: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(timeEntries.invoiceId, invoiceId),
        eq(timeEntries.workspaceId, workspaceId),
      ),
    )
    .returning({ id: timeEntries.id });

  const revertedExpenses = await tx
    .update(expenses)
    .set({
      status: BILLING_STATUS.APPROVED,
      invoiceId: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(expenses.invoiceId, invoiceId),
        eq(expenses.workspaceId, workspaceId),
      ),
    )
    .returning({ id: expenses.id });

  // The voided document keeps its lines; releasing them lets the
  // entries they billed go on another invoice.
  await tx
    .update(invoiceLines)
    .set({ releasedAt: now, updatedAt: now })
    .where(
      and(
        eq(invoiceLines.invoiceId, invoiceId),
        eq(invoiceLines.workspaceId, workspaceId),
        isNull(invoiceLines.releasedAt),
      ),
    );

  await recordAuditEvent(
    tx,
    buildVoidEvents({
      invoiceId,
      previousStatus,
      paymentChanges,
      revertedTimeEntries,
      revertedExpenses,
    }),
  );
  return Result.ok(undefined);
};

type FinalizeInvoiceOptions = {
  invoice: NonNullable<Awaited<ReturnType<typeof lockInvoiceInStatus>>>;
  workspaceId: SafeId<"workspace">;
  now: Date;
};
const prepareFinalizedInvoice = async (
  tx: Transaction,
  { invoice, workspaceId, now }: FinalizeInvoiceOptions,
) => {
  const valid = await validateInvoiceDocument(tx, {
    invoiceId: invoice.id,
    workspaceId,
    documentType: invoice.documentType,
    originalInvoiceId: invoice.originalInvoiceId,
    currency: invoice.currency,
    totalAmount: invoice.totalAmount,
  });
  if (valid.isErr()) {
    return Result.err(valid.error);
  }
  const finalizedAt = invoice.finalizedAt ?? now;
  if (invoice.invoiceNumber !== null) {
    return Result.ok({ finalizedAt });
  }
  const series = await findDefaultNumberSeries(tx, invoice.documentType);
  if (!series) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "No default number series configured for this document type",
        hint: "Create or update a number series with this documentType and isDefault=true, then finalize again.",
      }),
    );
  }
  const number = await allocateNumber(
    tx,
    series.id,
    new Date(`${invoice.invoiceDate}T00:00:00Z`),
  );
  return number.map(({ number: invoiceNumber }) => ({
    finalizedAt,
    invoiceNumber,
  }));
};

const transitionInvoice = createSafeHandler(
  {
    description:
      "Move an invoice through finalize, send, mark_paid, undo_paid, void, or revert_to_draft. " +
      "mark_paid accepts paidDate (UTC today by default), paidAmountMinor (full total by default), and optional note/reference. Only full payment is supported; credit notes cannot record client payments. " +
      "An identical payment resend succeeds without repeating audit events. Only organization owners/admins may undo_paid; this returns paid invoices to sent and clears payment details. " +
      "Finalize assigns an omitted number from the document type's default series, " +
      "using the issue date; configure a default number series first. Manual numbers " +
      "and numbers kept after reverting to draft are preserved. A credit note must " +
      "reference an eligible original and cannot exceed its total. Voiding releases " +
      "attached entries and clears payment details while retaining them in the audit trail.",
    permissions: { invoice: ["update"] },
    mcp: { type: "capability", reason: "billing_admin" },
    params: invoiceParamsSchema,
    body: transitionInvoiceBodySchema,
  },
  async function* ({
    safeDb,
    user,
    workspaceId,
    params,
    body,
    recordAuditEvent,
    memberRole,
  }) {
    const transition = TRANSITIONS[body.action];
    const now = new Date();
    const result = await resultTx(
      safeDb,
      async (tx): Promise<Result<{ id: SafeId<"invoice"> }, HandlerError>> => {
        if (body.action === "void") {
          const runningError = await guardRunningTimeEntries({
            tx,
            workspaceId,
            actorUserId: user.id,
            selection: { type: "invoice", invoiceId: params.invoiceId },
          });
          if (runningError) {
            return Result.err(runningError);
          }
        }
        const existing = await lockInvoiceInStatus(tx, {
          invoiceId: params.invoiceId,
          workspaceId,
          status: transition.from,
        });
        if (!existing) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: `Cannot ${body.action} invoice from its current status`,
            }),
          );
        }
        const payment =
          body.action === "mark_paid" || body.action === "undo_paid"
            ? prepareInvoicePayment({
                invoice: existing,
                body,
                memberRole,
                now,
              })
            : Result.ok({
                type: "update",
                fields: body.action === "void" ? EMPTY_INVOICE_PAYMENT : {},
              } as const);
        if (payment.isErr()) {
          return Result.err(payment.error);
        }
        if (payment.value.type === "replay") {
          return Result.ok({ id: existing.id });
        }
        const paymentChanges = invoicePaymentAuditChanges(
          existing,
          payment.value.fields,
        );
        if (body.action === "void" || body.action === "revert_to_draft") {
          const credit = await tx
            .select({ id: invoices.id })
            .from(invoices)
            .where(
              and(
                eq(invoices.workspaceId, workspaceId),
                eq(invoices.originalInvoiceId, existing.id),
                ne(invoices.status, INVOICE_STATUS.VOID),
              ),
            )
            .limit(1);
          if (credit.at(0)) {
            return Result.err(
              new HandlerError({
                status: 409,
                message:
                  "Void linked credit notes before changing their original invoice",
              }),
            );
          }
        }
        const set: Partial<typeof invoices.$inferInsert> = {
          status: transition.to,
          updatedAt: now,
          ...payment.value.fields,
        };
        if (body.action === "revert_to_draft") {
          set.finalizedAt = existing.finalizedAt ?? now;
        }
        if (body.action === "finalize") {
          const finalized = await prepareFinalizedInvoice(tx, {
            invoice: existing,
            workspaceId,
            now,
          });
          if (finalized.isErr()) {
            return Result.err(finalized.error);
          }
          Object.assign(set, finalized.value);
        }
        const updated = await tx
          .update(invoices)
          .set(set)
          .where(
            and(
              eq(invoices.id, params.invoiceId),
              eq(invoices.workspaceId, workspaceId),
              inArray(invoices.status, transition.from),
            ),
          )
          .returning({ id: invoices.id });
        const row = updated.at(0);
        if (!row) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: `Cannot ${body.action} invoice from its current status`,
            }),
          );
        }
        if (body.action === "void") {
          const release = await releaseInvoiceEntries(tx, {
            actorUserId: user.id,
            invoiceId: row.id,
            workspaceId,
            previousStatus: existing.status,
            paymentChanges,
            now,
            recordAuditEvent,
          });
          if (release.isErr()) {
            return Result.err(release.error);
          }
        } else {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
            resourceId: row.id,
            changes: {
              status: { old: existing.status, new: transition.to },
              action: { old: null, new: body.action },
              ...paymentChanges,
              ...(set.invoiceNumber !== undefined
                ? {
                    invoiceNumber: {
                      old: existing.invoiceNumber,
                      new: set.invoiceNumber,
                    },
                  }
                : {}),
            },
          });
        }
        return Result.ok({ id: row.id });
      },
    );
    if (
      result.isErr() &&
      DatabaseError.is(result.error) &&
      result.error.code === PG_ERROR.UNIQUE_VIOLATION
    ) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "An invoice with this number already exists",
        }),
      );
    }
    const transitioned = yield* result;
    return Result.ok(transitioned);
  },
);

export default transitionInvoice;
