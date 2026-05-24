import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { INVOICE_STATUS, invoices } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
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
            changes: Object.fromEntries(
              Object.entries(changedFields).map(([key, value]) => [
                key,
                { old: null, new: value },
              ]),
            ),
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
