import { and, eq, inArray } from "drizzle-orm";
import { status, t } from "elysia";

import {
  BILLING_STATUS,
  expenses,
  INVOICE_STATUS,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import type { InvoiceStatus } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

type TransitionAction =
  | "finalize"
  | "send"
  | "mark_paid"
  | "void"
  | "revert_to_draft";

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
} as const satisfies Record<
  TransitionAction,
  { from: InvoiceStatus[]; to: InvoiceStatus }
>;

export const transitionInvoiceBodySchema = t.Object({
  action: t.UnionEnum([
    "finalize",
    "send",
    "mark_paid",
    "void",
    "revert_to_draft",
  ]),
});

const invoiceParamsSchema = t.Object({
  invoiceId: tNanoid,
});

const transitionInvoice = createHandler(
  {
    permissions: { invoice: ["update"] },
    params: invoiceParamsSchema,
    body: transitionInvoiceBodySchema,
  },
  async ({ scopedDb, workspaceId, params, body }) => {
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

    if (body.action === "void") {
      const result = await scopedDb(async (tx) => {
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

        const voidedInvoice = updated.at(0);
        if (!voidedInvoice) {
          return null;
        }

        await tx
          .update(timeEntries)
          .set({
            status: BILLING_STATUS.APPROVED,
            invoiceId: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(timeEntries.invoiceId, params.invoiceId),
              eq(timeEntries.workspaceId, workspaceId),
            ),
          );

        await tx
          .update(expenses)
          .set({
            status: BILLING_STATUS.APPROVED,
            invoiceId: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(expenses.invoiceId, params.invoiceId),
              eq(expenses.workspaceId, workspaceId),
            ),
          );

        return { id: voidedInvoice.id };
      });

      if (!result) {
        return status(409, {
          message: "Invoice cannot be voided from its current status",
        });
      }

      return result;
    }

    const result = await scopedDb((tx) =>
      tx
        .update(invoices)
        .set(set)
        .where(
          and(
            eq(invoices.id, params.invoiceId),
            eq(invoices.workspaceId, workspaceId),
            inArray(invoices.status, transition.from),
          ),
        )
        .returning({ id: invoices.id }),
    );

    const transitioned = result.at(0);
    if (!transitioned) {
      return status(409, {
        message: `Cannot ${body.action} invoice from its current status`,
      });
    }

    return { id: transitioned.id };
  },
);

export default transitionInvoice;
