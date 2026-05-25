import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { INVOICE_STATUS, invoices } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { FieldDiffs } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { pickDefined } from "@/api/lib/pick-defined";

const updateInvoiceBodySchema = t.Object({
  invoiceNumber: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  invoiceDate: t.Optional(t.String({ format: "date" })),
  dueDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  reference: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
  currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
  notes: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
});

const invoiceParamsSchema = workspaceParams({ invoiceId: tSafeId("invoice") });

type InvoiceUpdateSource = {
  currency: string;
  dueDate: string | null;
  invoiceDate: string;
  invoiceNumber: string;
  notes: string | null;
  reference: string | null;
};

type InvoiceUpdateChanges = Partial<InvoiceUpdateSource>;

const buildInvoiceUpdateAuditChanges = (
  existing: InvoiceUpdateSource,
  changedFields: InvoiceUpdateChanges,
): FieldDiffs => {
  const changes: FieldDiffs = {};
  if (changedFields.invoiceNumber !== undefined) {
    changes["invoiceNumber"] = {
      old: existing.invoiceNumber,
      new: changedFields.invoiceNumber,
    };
  }
  if (changedFields.invoiceDate !== undefined) {
    changes["invoiceDate"] = {
      old: existing.invoiceDate,
      new: changedFields.invoiceDate,
    };
  }
  if (changedFields.dueDate !== undefined) {
    changes["dueDate"] = {
      old: existing.dueDate,
      new: changedFields.dueDate,
    };
  }
  if (changedFields.reference !== undefined) {
    changes["reference"] = {
      old: existing.reference,
      new: changedFields.reference,
    };
  }
  if (changedFields.notes !== undefined) {
    changes["notes"] = { old: existing.notes, new: changedFields.notes };
  }
  if (changedFields.currency !== undefined) {
    changes["currency"] = {
      old: existing.currency,
      new: changedFields.currency,
    };
  }
  return changes;
};

const updateInvoice = createSafeHandler(
  {
    permissions: { invoice: ["update"] },
    params: invoiceParamsSchema,
    body: updateInvoiceBodySchema,
  },
  async function* ({ safeDb, workspaceId, params, body, recordAuditEvent }) {
    const changedFields = pickDefined(body, [
      "invoiceNumber",
      "invoiceDate",
      "dueDate",
      "reference",
      "notes",
      "currency",
    ]);
    const set = {
      ...changedFields,
      updatedAt: new Date(),
    };

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const existingRows = await tx
          .select({
            id: invoices.id,
            currency: invoices.currency,
            dueDate: invoices.dueDate,
            invoiceDate: invoices.invoiceDate,
            invoiceNumber: invoices.invoiceNumber,
            notes: invoices.notes,
            reference: invoices.reference,
          })
          .from(invoices)
          .where(
            and(
              eq(invoices.id, params.invoiceId),
              eq(invoices.workspaceId, workspaceId),
              eq(invoices.status, INVOICE_STATUS.DRAFT),
            ),
          )
          .limit(1)
          .for("update");
        const existing = existingRows.at(0);
        if (!existing) {
          return [];
        }

        const updated = await tx
          .update(invoices)
          .set(set)
          .where(
            and(
              eq(invoices.id, params.invoiceId),
              eq(invoices.workspaceId, workspaceId),
              eq(invoices.status, INVOICE_STATUS.DRAFT),
            ),
          )
          .returning({ id: invoices.id });

        const row = updated.at(0);
        if (row) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
            resourceId: row.id,
            changes: buildInvoiceUpdateAuditChanges(existing, changedFields),
          });
        }
        return updated;
      }),
    );

    const updated = result.at(0);
    if (!updated) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Invoice not found or not in draft status",
        }),
      );
    }
    return Result.ok({ id: updated.id });
  },
);

export default updateInvoice;
