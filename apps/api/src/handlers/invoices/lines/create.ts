import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  expenses,
  INVOICE_STATUS,
  invoiceLines,
  timeEntries,
} from "@/api/db/schema";
import {
  expenseLineDraft,
  type InvoiceLineDraft,
  insertInvoiceLines,
  manualLineDraft,
  recalculateInvoiceTotals,
  tInvoiceLineQuantity,
  tLineDescription,
  tLineUnit,
  timeEntryLineDraft,
  tVatRateBps,
  tVatTreatment,
} from "@/api/handlers/invoices/invoice-lines";
import { lockInvoiceInStatus } from "@/api/handlers/invoices/lock-invoice";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import {
  tMinorUnitAmount,
  tSafeId,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import { PG_ERROR } from "@/api/lib/pg-error";

const createLineBodySchema = t.Object({
  source: t.Union([
    t.Object({
      type: t.Literal("manual"),
      description: tLineDescription,
      quantity: tInvoiceLineQuantity,
      unit: t.Optional(t.Nullable(tLineUnit)),
      unitPriceMinor: tMinorUnitAmount(0),
    }),
    t.Object({
      type: t.Literal("time_entry"),
      timeEntryId: tSafeId("timeEntry"),
      description: t.Optional(tLineDescription),
    }),
    t.Object({
      type: t.Literal("expense"),
      expenseId: tSafeId("expense"),
      description: t.Optional(tLineDescription),
    }),
  ]),
  vatRateBps: tVatRateBps,
  vatTreatment: tVatTreatment,
});

const lineParamsSchema = workspaceParams({ invoiceId: tSafeId("invoice") });

const NOT_BILLABLE_MESSAGE =
  "The entry must be approved, billable, priced in the invoice currency, and not already on an invoice";

const createInvoiceLine = createSafeHandler(
  {
    description:
      "Add one line to a draft invoice and recompute its totals. The source " +
      "is a manual line (description, decimal quantity, optional unit, unit " +
      "price in minor units), an approved unbilled time entry, or an " +
      "approved unbilled expense; an entry line takes its amount from the " +
      "entry and marks the entry billed. Every line carries a VAT rate in " +
      "basis points and a VAT treatment. Only draft invoices accept lines.",
    permissions: { invoice: ["update"] },
    mcp: { type: "capability", reason: "billing_admin" },
    params: lineParamsSchema,
    body: createLineBodySchema,
  },
  async function* ({
    safeDb,
    session,
    workspaceId,
    params,
    body,
    recordAuditEvent,
  }) {
    const vat = {
      vatRateBps: body.vatRateBps,
      vatTreatment: body.vatTreatment,
    };
    const { source } = body;
    let manualDraft: InvoiceLineDraft | null = null;
    if (source.type === "manual") {
      manualDraft = yield* manualLineDraft({
        description: source.description,
        quantity: source.quantity,
        unit: source.unit ?? null,
        unitPrice: cents(source.unitPriceMinor),
        ...vat,
      });
    }
    const now = new Date();

    const txResult = await abortableTx(safeDb, async (tx) => {
      const invoice = await lockInvoiceInStatus(tx, {
        invoiceId: params.invoiceId,
        workspaceId,
        status: INVOICE_STATUS.DRAFT,
      });
      if (!invoice) {
        throw new HandlerError({
          status: 409,
          message: "Invoice not found or not in draft status",
        });
      }

      const lineCount = await tx.$count(
        invoiceLines,
        and(
          eq(invoiceLines.invoiceId, params.invoiceId),
          eq(invoiceLines.workspaceId, workspaceId),
        ),
      );
      if (lineCount >= LIMITS.invoiceLinesPerInvoice) {
        throw new HandlerError({
          status: 400,
          message: `An invoice holds at most ${LIMITS.invoiceLinesPerInvoice} lines`,
        });
      }

      const events: AuditEvent[] = [];
      let draft = manualDraft;
      if (source.type === "time_entry") {
        const [entry] = await tx
          .update(timeEntries)
          .set({
            invoiceId: params.invoiceId,
            status: BILLING_STATUS.BILLED,
            updatedAt: now,
          })
          .where(
            and(
              eq(timeEntries.id, source.timeEntryId),
              eq(timeEntries.workspaceId, workspaceId),
              eq(timeEntries.status, BILLING_STATUS.APPROVED),
              eq(timeEntries.billable, true),
              isNull(timeEntries.invoiceId),
              eq(timeEntries.currency, invoice.currency),
            ),
          )
          .returning({
            id: timeEntries.id,
            billedMinutes: timeEntries.billedMinutes,
            rateAtEntry: timeEntries.rateAtEntry,
            narrative: timeEntries.narrative,
            invoiceNarrative: timeEntries.invoiceNarrative,
            currency: timeEntries.currency,
          });
        if (!entry || entry.currency === UNPRICED_TIME_ENTRY_CURRENCY) {
          throw new HandlerError({
            status: 400,
            message: NOT_BILLABLE_MESSAGE,
          });
        }
        draft = timeEntryLineDraft(entry, vat, source.description);
        events.push({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
          resourceId: entry.id,
          changes: {
            status: {
              old: BILLING_STATUS.APPROVED,
              new: BILLING_STATUS.BILLED,
            },
            invoiceId: { old: null, new: params.invoiceId },
          },
        });
      } else if (source.type === "expense") {
        const [expense] = await tx
          .update(expenses)
          .set({
            invoiceId: params.invoiceId,
            status: BILLING_STATUS.BILLED,
            updatedAt: now,
          })
          .where(
            and(
              eq(expenses.id, source.expenseId),
              eq(expenses.workspaceId, workspaceId),
              eq(expenses.status, BILLING_STATUS.APPROVED),
              eq(expenses.billable, true),
              isNull(expenses.invoiceId),
              eq(expenses.currency, invoice.currency),
            ),
          )
          .returning({
            id: expenses.id,
            amount: expenses.amount,
            markup: expenses.markup,
            description: expenses.description,
            invoiceDescription: expenses.invoiceDescription,
          });
        if (!expense) {
          throw new HandlerError({
            status: 400,
            message: NOT_BILLABLE_MESSAGE,
          });
        }
        draft = expenseLineDraft(expense, vat, source.description);
        events.push({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.EXPENSE,
          resourceId: expense.id,
          changes: {
            status: {
              old: BILLING_STATUS.APPROVED,
              new: BILLING_STATUS.BILLED,
            },
            invoiceId: { old: null, new: params.invoiceId },
          },
        });
      }
      if (!draft) {
        throw new HandlerError({ status: 400, message: "Unknown line source" });
      }

      const scope = { invoiceId: params.invoiceId, workspaceId };
      const [line] = await insertInvoiceLines(
        tx,
        { ...scope, organizationId: session.activeOrganizationId },
        [draft],
      );
      if (!line) {
        throw new HandlerError({ status: 500, message: "Line was not saved" });
      }
      const totals = await recalculateInvoiceTotals(tx, scope, now);

      await recordAuditEvent(tx, [
        {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
          resourceId: params.invoiceId,
          changes: {
            lineAdded: {
              old: null,
              new: {
                id: line.id,
                source: line.source,
                netAmount: draft.netAmount,
                vatRateBps: draft.vatRateBps,
              },
            },
            totalAmount: {
              old: invoice.totalAmount,
              new: totals.grossAmountMinor,
            },
          },
        },
        ...events,
      ]);

      return { id: line.id, totals };
    });

    if (Result.isError(txResult)) {
      const error = txResult.error;
      // The partial unique index is the last guard: the entry already sits on
      // another invoice's line.
      if (DatabaseError.is(error) && error.code === PG_ERROR.UNIQUE_VIOLATION) {
        return Result.err(
          new HandlerError({ status: 409, message: NOT_BILLABLE_MESSAGE }),
        );
      }
      return Result.err(error);
    }

    return Result.ok(txResult.value);
  },
);

export default createInvoiceLine;
