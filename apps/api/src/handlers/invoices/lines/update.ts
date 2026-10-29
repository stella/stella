import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { type InvoiceTotals, quantityText } from "@stll/invoicing";

import { resultTx } from "@/api/db/safe-db";
import { invoiceLines } from "@/api/db/schema";
import { invoiceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { flatFeeInvoiceRefusal } from "@/api/lib/billing/invoice-arrangements";
import {
  type InvoiceLineDraft,
  lockDraftInvoiceForLines,
  manualLineDraft,
  priceLines,
  recalculateInvoiceTotals,
  tExemptionReason,
  tInvoiceLineQuantity,
  tLineDescription,
  tLineUnit,
  tVatRateBps,
  tVatTreatment,
} from "@/api/lib/billing/invoice-lines";
import type { SafeId } from "@/api/lib/branded-types";
import {
  minorUnitAmountSchema,
  resourceIdSchema,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";
import { pickDefined } from "@/api/lib/pick-defined";

const updateLineBodySchema = v.object({
  description: v.optional(tLineDescription),
  quantity: v.optional(tInvoiceLineQuantity),
  unit: v.optional(v.nullable(tLineUnit)),
  unitPriceMinor: v.optional(minorUnitAmountSchema(0)),
  vatRateBps: v.optional(tVatRateBps),
  vatTreatment: v.optional(tVatTreatment),
  resetToRecorded: v.optional(v.literal(true)),
  exemptionReason: v.optional(tExemptionReason),
});

const lineParamsSchema = workspaceParams({
  invoiceId: resourceIdSchema("invoice"),
  lineId: resourceIdSchema("invoiceLine"),
});

type UpdatedLine = { id: SafeId<"invoiceLine">; totals: InvoiceTotals };

const UPDATED_FIELDS = [
  "description",
  "quantity",
  "unit",
  "unitPriceMinor",
  "vatRateBps",
  "vatTreatment",
  "exemptionReason",
] as const;

type LineAmountPatch = Pick<
  v.InferOutput<typeof updateLineBodySchema>,
  "quantity" | "unitPriceMinor"
>;
type StoredLineAmount = Pick<InvoiceLineDraft, "quantity" | "unitPrice">;

const changesLineAmount = (changed: LineAmountPatch, line: StoredLineAmount) =>
  (changed.quantity !== undefined &&
    quantityText(changed.quantity) !== quantityText(line.quantity)) ||
  (changed.unitPriceMinor !== undefined &&
    changed.unitPriceMinor !== line.unitPrice);

const updateInvoiceLine = createSafeHandler(
  {
    contract: "patch",
    description:
      "Change one line of a draft invoice and recompute its totals. Any line " +
      "accepts description, quantity, unit price, and VAT overrides without " +
      "changing the source time entry or expense. Set resetToRecorded to true " +
      "alone to restore the recorded description, quantity, unit and price. " +
      "Recorded values remain available for reporting. A flat-fee line keeps its " +
      "snapshotted quantity, unit, and price; its description and VAT may change. Omitted fields stay " +
      "unchanged. Only drafts that have never been issued can be edited; " +
      "issued invoices require a credit note, even after reverting to draft.",
    permissions: { invoice: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: invoiceRealtimeUpdates,
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
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
    if (body.resetToRecorded && changedFields.length > 0) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Reset cannot be combined with line changes",
        }),
      );
    }
    if (changedFields.length === 0 && !body.resetToRecorded) {
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
      resultTx(
        safeDb,
        async (tx): Promise<Result<UpdatedLine, HandlerError>> => {
          const invoiceResult = await lockDraftInvoiceForLines(
            tx,
            {
              invoiceId: params.invoiceId,
              matterLocks: { type: "acquire" },
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

          const changesAmount = changesLineAmount(changed, line);
          if (
            invoice.billingMode === "flat_fee" &&
            (changesAmount ||
              (changed.unit !== undefined && changed.unit !== line.unit))
          ) {
            return Result.err(flatFeeInvoiceRefusal());
          }
          const recorded = {
            recordedDescription: line.recordedDescription ?? line.description,
            recordedQuantity: line.recordedQuantity ?? line.quantity,
            recordedUnit:
              line.recordedDescription === null ? line.unit : line.recordedUnit,
            recordedUnitPrice: line.recordedUnitPrice ?? line.unitPrice,
            recordedNetAmount:
              line.recordedNetAmount ?? cents(Math.abs(line.netAmount)),
          };
          const values = body.resetToRecorded
            ? {
                description: recorded.recordedDescription,
                quantity: recorded.recordedQuantity,
                unit: recorded.recordedUnit,
                unitPriceMinor: recorded.recordedUnitPrice,
              }
            : changed;

          const vat = {
            vatRateBps: changed.vatRateBps ?? line.vatRateBps,
            vatTreatment: changed.vatTreatment ?? line.vatTreatment,
            exemptionReason:
              changed.exemptionReason === undefined
                ? line.exemptionReason
                : changed.exemptionReason,
          };
          let draft: InvoiceLineDraft = {
            description: values.description ?? line.description,
            quantity: line.quantity,
            unit: values.unit === undefined ? line.unit : values.unit,
            unitPrice: line.unitPrice,
            netAmount: cents(Math.abs(line.netAmount)),
            ...vat,
            source: line.source,
            billingPurpose: line.billingPurpose,
            timeEntryId: line.timeEntryId,
            expenseId: line.expenseId,
          };
          if (changesAmount || body.resetToRecorded) {
            const manual = manualLineDraft({
              description: draft.description,
              quantity: values.quantity ?? line.quantity,
              unit: values.unit === undefined ? line.unit : values.unit,
              unitPrice:
                values.unitPriceMinor === undefined
                  ? line.unitPrice
                  : cents(values.unitPriceMinor),
              ...vat,
            });
            if (manual.isErr()) {
              return Result.err(manual.error);
            }
            draft = {
              ...manual.value,
              source: line.source,
              timeEntryId: line.timeEntryId,
              expenseId: line.expenseId,
              billingPurpose: line.billingPurpose,
              ...(body.resetToRecorded
                ? { netAmount: cents(Math.abs(recorded.recordedNetAmount)) }
                : {}),
            };
          }
          const priced = priceLines([draft], invoice.documentType);
          if (priced.isErr()) {
            return Result.err(priced.error);
          }
          const pricedLine =
            priced.value[0] ?? panic("Pricing one line returned no line");

          await tx
            .update(invoiceLines)
            .set({
              ...recorded,
              description: pricedLine.description,
              quantity: pricedLine.quantity,
              unit: pricedLine.unit,
              unitPrice: pricedLine.unitPrice,
              netAmount: pricedLine.netAmount,
              vatRateBps: pricedLine.vatRateBps,
              vatTreatment: pricedLine.vatTreatment,
              exemptionReason: pricedLine.exemptionReason,
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
          // The new totals record their own invoice event.
          const totals = await recalculateInvoiceTotals(
            tx,
            { invoiceId: params.invoiceId, workspaceId },
            now,
            recordAuditEvent,
          );

          if (totals.isErr()) {
            return Result.err(totals.error);
          }

          // Field names only: a line description can quote privileged work.
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
            resourceId: params.invoiceId,
            changes: {
              lineNetAmount: { old: line.netAmount, new: pricedLine.netAmount },
            },
            metadata: {
              lineId: line.id,
              changedFields: body.resetToRecorded
                ? ["resetToRecorded"]
                : changedFields,
            },
          });

          return Result.ok({ id: line.id, totals: totals.value });
        },
      ),
    );

    return Result.ok(result);
  },
);

export default updateInvoiceLine;
