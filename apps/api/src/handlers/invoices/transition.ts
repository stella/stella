import { and, eq, inArray } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import {
  BILLING_STATUS,
  expenses,
  INVOICE_STATUS,
  invoices,
  timeEntries,
  type InvoiceStatus,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type TransitionAction =
  | "finalize"
  | "send"
  | "mark_paid"
  | "void"
  | "revert_to_draft";

const TRANSITIONS: Record<
  TransitionAction,
  { from: InvoiceStatus[]; to: InvoiceStatus }
> = {
  finalize: {
    from: [INVOICE_STATUS.DRAFT],
    to: INVOICE_STATUS.FINALIZED,
  },
  send: {
    from: [INVOICE_STATUS.FINALIZED],
    to: INVOICE_STATUS.SENT,
  },
  mark_paid: {
    from: [INVOICE_STATUS.SENT],
    to: INVOICE_STATUS.PAID,
  },
  void: {
    from: [INVOICE_STATUS.FINALIZED, INVOICE_STATUS.SENT, INVOICE_STATUS.PAID],
    to: INVOICE_STATUS.VOID,
  },
  revert_to_draft: {
    from: [INVOICE_STATUS.FINALIZED],
    to: INVOICE_STATUS.DRAFT,
  },
};

export const transitionInvoiceBodySchema = t.Object({
  action: t.UnionEnum([
    "finalize",
    "send",
    "mark_paid",
    "void",
    "revert_to_draft",
  ]),
});

type TransitionInvoiceBodySchema = Static<typeof transitionInvoiceBodySchema>;

type TransitionInvoiceHandlerProps = {
  workspaceId: SafeId<"workspace">;
  invoiceId: string;
  body: TransitionInvoiceBodySchema;
};

export const transitionInvoiceHandler = async ({
  workspaceId,
  invoiceId,
  body,
}: TransitionInvoiceHandlerProps) => {
  const transition = TRANSITIONS[body.action];
  const now = new Date();

  const set: Partial<typeof invoices.$inferInsert> = {
    status: transition.to,
    updatedAt: now,
  };

  if (body.action === "mark_paid") {
    set.paidAt = now;
  } else if (body.action === "void") {
    set.paidAt = null;
  }

  // Void requires a transaction: revert linked entries.
  if (body.action === "void") {
    const result = await db.transaction(async (tx) => {
      const updated = await tx
        .update(invoices)
        .set(set)
        .where(
          and(
            eq(invoices.id, invoiceId),
            eq(invoices.workspaceId, workspaceId),
            inArray(invoices.status, transition.from),
          ),
        )
        .returning({ id: invoices.id });

      if (updated.length === 0) {
        return null;
      }

      // Revert time entries: billed → approved, clear invoiceId.
      await tx
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
        );

      // Revert expenses: clear invoiceId and reset status.
      await tx
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
        );

      return { id: updated[0].id };
    });

    if (!result) {
      return status(409, {
        message: "Invoice cannot be voided from its current status",
      });
    }

    return result;
  }

  // Non-void transitions: simple status update.
  const result = await db
    .update(invoices)
    .set(set)
    .where(
      and(
        eq(invoices.id, invoiceId),
        eq(invoices.workspaceId, workspaceId),
        inArray(invoices.status, transition.from),
      ),
    )
    .returning({ id: invoices.id });

  if (result.length === 0) {
    return status(409, {
      message: `Cannot ${body.action} invoice from its current status`,
    });
  }

  return { id: result[0].id };
};
