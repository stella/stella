import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { INVOICE_LINE_SOURCE } from "@stll/api-contract";
import type { InvoiceTotals } from "@stll/invoicing";

import { abortableTx } from "@/api/db/safe-db";
import { invoiceLines } from "@/api/db/schema";
import {
  type InvoiceLineDraft,
  lockDraftInvoiceForLines,
  manualLineDraft,
  priceLines,
  recalculateInvoiceTotals,
  tInvoiceLineQuantity,
  tLineDescription,
  tLineUnit,
  tVatRateBps,
  tVatTreatment,
} from "@/api/handlers/invoices/invoice-lines";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  tMinorUnitAmount,
  tSafeId,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";
import { pickDefined } from "@/api/lib/pick-defined";

const updateLineBodySchema = t.Object({
  description: t.Optional(tLineDescription),
  quantity: t.Optional(tInvoiceLineQuantity),
  unit: t.Optional(t.Nullable(tLineUnit)),
  unitPriceMinor: t.Optional(tMinorUnitAmount(0)),
  vatRateBps: t.Optional(tVatRateBps),
  vatTreatment: t.Optional(tVatTreatment),
});

const lineParamsSchema = workspaceParams({
  invoiceId: tSafeId("invoice"),
  lineId: tSafeId("invoiceLine"),
});

type UpdatedLine = { id: SafeId<"invoiceLine">; totals: InvoiceTotals };

const UPDATED_FIELDS = [
  "description",
  "quantity",
  "unit",
  "unitPriceMinor",
  "vatRateBps",
  "vatTreatment",
] as const;

const updateInvoiceLine = createSafeHandler(
  {
    description:
      "Change one line of a draft invoice and recompute its totals. Any line " +
      "takes a new description, VAT rate, or VAT treatment; quantity, unit, " +
      "and unit price change only on a manual line, because a time entry or " +
      "expense line takes its amount from the entry. Omitted fields stay " +
      "unchanged. Only draft invoices can be edited.",
    permissions: { invoice: ["update"] },
    mcp: { type: "capability", reason: "billing_admin" },
    params: lineParamsSchema,
    body: updateLineBodySchema,
  },
  async function* ({
    safeDb,
    session,
    workspaceId,
    params,
    body,
    recordAuditEvent,
  }) {
    const changed = pickDefined(body, UPDATED_FIELDS);
    const changedFields = Object.keys(changed);
    if (changedFields.length === 0) {
      return Result.err(
        new HandlerError({ status: 400, message: "No line fields to change" }),
      );
    }
    const now = new Date();

    // Every refusal below comes before this request writes anything, so
    // returning it commits no partial change.
    const refuse = (status: 400 | 404 | 409, message: string) =>
      Result.err(new HandlerError({ status, message }));

    const result = yield* Result.await(
      abortableTx(
        safeDb,
        async (tx): Promise<Result<UpdatedLine, HandlerError>> => {
          const invoice = await lockDraftInvoiceForLines(tx, {
            invoiceId: params.invoiceId,
            organizationId: session.activeOrganizationId,
            workspaceId,
          });
          if (!invoice) {
            return refuse(409, "Invoice not found or not in draft status");
          }
          const [line] = await tx
            .select()
            .from(invoiceLines)
            .where(
              and(
                eq(invoiceLines.id, params.lineId),
                eq(invoiceLines.invoiceId, params.invoiceId),
                eq(invoiceLines.workspaceId, workspaceId),
              ),
            )
            .limit(1);
          if (!line) {
            return refuse(404, "Invoice line not found");
          }

          const changesAmount =
            changed.quantity !== undefined ||
            changed.unit !== undefined ||
            changed.unitPriceMinor !== undefined;
          if (changesAmount && line.source !== INVOICE_LINE_SOURCE.MANUAL) {
            return refuse(
              400,
              "Quantity, unit, and unit price come from the entry; change them on a manual line only",
            );
          }

          const vat = {
            vatRateBps: changed.vatRateBps ?? line.vatRateBps,
            vatTreatment: changed.vatTreatment ?? line.vatTreatment,
          };
          let draft: InvoiceLineDraft = {
            description: changed.description ?? line.description,
            quantity: line.quantity,
            unit: line.unit,
            unitPrice: line.unitPrice,
            netAmount: line.netAmount,
            ...vat,
            source: line.source,
            timeEntryId: line.timeEntryId,
            expenseId: line.expenseId,
          };
          if (line.source === INVOICE_LINE_SOURCE.MANUAL) {
            const manual = manualLineDraft({
              description: draft.description,
              quantity: changed.quantity ?? line.quantity,
              unit: changed.unit === undefined ? line.unit : changed.unit,
              unitPrice:
                changed.unitPriceMinor === undefined
                  ? line.unitPrice
                  : cents(changed.unitPriceMinor),
              ...vat,
            });
            if (manual.isErr()) {
              return Result.err(manual.error);
            }
            draft = manual.value;
          }
          const priced = priceLines([draft]);
          if (priced.isErr()) {
            return Result.err(priced.error);
          }
          const pricedLine =
            priced.value[0] ?? panic("Pricing one line returned no line");

          await tx
            .update(invoiceLines)
            .set({
              description: pricedLine.description,
              quantity: pricedLine.quantity,
              unit: pricedLine.unit,
              unitPrice: pricedLine.unitPrice,
              netAmount: pricedLine.netAmount,
              vatRateBps: pricedLine.vatRateBps,
              vatTreatment: pricedLine.vatTreatment,
              vatAmount: pricedLine.vatAmount,
              grossAmount: pricedLine.grossAmount,
              updatedAt: now,
            })
            .where(
              and(
                eq(invoiceLines.id, line.id),
                eq(invoiceLines.workspaceId, workspaceId),
              ),
            );
          const totals = await recalculateInvoiceTotals(
            tx,
            { invoiceId: params.invoiceId, workspaceId },
            now,
          );

          // Field names only: a line description can quote privileged work.
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
            resourceId: params.invoiceId,
            changes: {
              lineNetAmount: { old: line.netAmount, new: pricedLine.netAmount },
              totalAmount: {
                old: invoice.totalAmount,
                new: totals.grossAmountMinor,
              },
            },
            metadata: { lineId: line.id, changedFields },
          });

          return Result.ok({ id: line.id, totals });
        },
      ),
    );

    return result;
  },
);

export default updateInvoiceLine;
