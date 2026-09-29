import { panic, Result } from "better-result";
import { and, eq, isNull, ne } from "drizzle-orm";
import { type Static, t } from "elysia";

import type { InvoiceTotals } from "@stll/invoicing";

import { resultTx } from "@/api/db/safe-db";
import { BILLING_STATUS, expenses, timeEntries } from "@/api/db/schema";
import {
  checkInvoiceLineCapacity,
  expenseLineDraft,
  type InvoiceLineDraft,
  insertInvoiceLines,
  lockDraftInvoiceForLines,
  manualLineDraft,
  recalculateInvoiceTotals,
  tInvoiceLineQuantity,
  tLineDescription,
  tLineUnit,
  timeEntryLineDraft,
  tVatRateBps,
  tVatTreatment,
} from "@/api/handlers/invoices/invoice-lines";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import type { SafeId } from "@/api/lib/branded-types";
import {
  tMinorUnitAmount,
  tSafeId,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
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

const prepareManualDraft = ({
  source,
  vatRateBps,
  vatTreatment,
}: Static<typeof createLineBodySchema>) => {
  if (source.type !== "manual") {
    return Result.ok(null);
  }
  return manualLineDraft({
    description: source.description,
    quantity: source.quantity,
    unit: source.unit ?? null,
    unitPrice: cents(source.unitPriceMinor),
    vatRateBps,
    vatTreatment,
  });
};

const lineParamsSchema = workspaceParams({ invoiceId: tSafeId("invoice") });

type CreatedLine = { id: SafeId<"invoiceLine">; totals: InvoiceTotals };

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
    const manualDraft = yield* prepareManualDraft(body);
    const now = new Date();

    const txResult = await resultTx(
      safeDb,
      async (tx): Promise<Result<CreatedLine, HandlerError>> => {
        const invoiceResult = await lockDraftInvoiceForLines(
          tx,
          {
            invoiceId: params.invoiceId,
            organizationId: session.activeOrganizationId,
            workspaceId,
          },
          recordAuditEvent,
        );
        if (invoiceResult.isErr()) {
          return Result.err(invoiceResult.error);
        }
        const invoice = invoiceResult.value;
        if (!invoice) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: "Invoice not found or not in draft status",
            }),
          );
        }

        if (
          invoice.documentType === "credit_note" &&
          source.type !== "manual"
        ) {
          return Result.err(
            new HandlerError({
              status: 422,
              message: "Credit notes cannot bill time entries or expenses",
            }),
          );
        }
        const capacity = await checkInvoiceLineCapacity(
          tx,
          { invoiceId: params.invoiceId, workspaceId },
          1,
        );
        if (capacity.isErr()) {
          return Result.err(capacity.error);
        }

        // Read and lock the entry the line bills before writing anything, so
        // a refusal commits nothing.
        let draft: InvoiceLineDraft;
        if (source.type === "time_entry") {
          const [entry] = await tx
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
                eq(timeEntries.id, source.timeEntryId),
                eq(timeEntries.workspaceId, workspaceId),
                eq(timeEntries.status, BILLING_STATUS.APPROVED),
                eq(timeEntries.billable, true),
                isNull(timeEntries.invoiceId),
                eq(timeEntries.currency, invoice.currency),
                ne(timeEntries.currency, UNPRICED_TIME_ENTRY_CURRENCY),
              ),
            )
            .limit(1)
            .for("update");
          if (!entry) {
            return Result.err(
              new HandlerError({ status: 400, message: NOT_BILLABLE_MESSAGE }),
            );
          }
          draft = timeEntryLineDraft(entry, vat, source.description);
        } else if (source.type === "expense") {
          const [expense] = await tx
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
                eq(expenses.id, source.expenseId),
                eq(expenses.workspaceId, workspaceId),
                eq(expenses.status, BILLING_STATUS.APPROVED),
                eq(expenses.billable, true),
                isNull(expenses.invoiceId),
                eq(expenses.currency, invoice.currency),
              ),
            )
            .limit(1)
            .for("update");
          if (!expense) {
            return Result.err(
              new HandlerError({ status: 400, message: NOT_BILLABLE_MESSAGE }),
            );
          }
          draft = expenseLineDraft(expense, vat, source.description);
        } else {
          draft = manualDraft ?? panic("A manual line has no draft");
        }

        // The locked entry is still eligible, so its claim cannot miss.
        const events: AuditEvent[] = [];
        const billed = {
          invoiceId: params.invoiceId,
          status: BILLING_STATUS.BILLED,
          updatedAt: now,
        };
        const billedChanges = {
          status: { old: BILLING_STATUS.APPROVED, new: BILLING_STATUS.BILLED },
          invoiceId: { old: null, new: params.invoiceId },
        };
        if (draft.timeEntryId !== null) {
          await tx
            .update(timeEntries)
            .set(billed)
            .where(
              and(
                eq(timeEntries.id, draft.timeEntryId),
                eq(timeEntries.workspaceId, workspaceId),
              ),
            );
          events.push({
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
            resourceId: draft.timeEntryId,
            changes: billedChanges,
          });
        }
        if (draft.expenseId !== null) {
          await tx
            .update(expenses)
            .set(billed)
            .where(
              and(
                eq(expenses.id, draft.expenseId),
                eq(expenses.workspaceId, workspaceId),
              ),
            );
          events.push({
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.EXPENSE,
            resourceId: draft.expenseId,
            changes: billedChanges,
          });
        }

        const scope = { invoiceId: params.invoiceId, workspaceId };
        // The line and the new totals record their own invoice events.
        const [line] = await insertInvoiceLines(
          tx,
          { ...scope, organizationId: session.activeOrganizationId },
          [draft],
          { recordAuditEvent },
        );
        if (!line) {
          return panic("Invoice line insert returned no row");
        }
        const totals = await recalculateInvoiceTotals(
          tx,
          scope,
          now,
          recordAuditEvent,
        );

        if (totals.isErr()) {
          return Result.err(totals.error);
        }

        await recordAuditEvent(tx, events);

        return Result.ok({ id: line.id, totals: totals.value });
      },
    );

    return txResult.mapError((error) =>
      DatabaseError.is(error) && error.code === PG_ERROR.UNIQUE_VIOLATION
        ? new HandlerError({
            status: 409,
            message: NOT_BILLABLE_MESSAGE,
          })
        : error,
    );
  },
);

export default createInvoiceLine;
