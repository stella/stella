import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import {
  expenses,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
  sellerProfiles,
  timeEntries,
} from "@/api/db/schema";
import { lockInvoiceInStatus } from "@/api/handlers/invoices/lock-invoice";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { FieldDiffs } from "@/api/lib/audit-log";
import {
  tCurrencyCode,
  tSafeId,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { pickDefined } from "@/api/lib/pick-defined";

const updateInvoiceBodySchema = t.Object({
  invoiceNumber: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  invoiceDate: t.Optional(t.String({ format: "date" })),
  dueDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  reference: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
  currency: t.Optional(tCurrencyCode),
  notes: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
  taxableSupplyDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  sellerProfileId: t.Optional(t.Nullable(tSafeId("sellerProfile"))),
  buyerName: t.Optional(t.Nullable(t.String({ minLength: 1, maxLength: 512 }))),
  buyerRegistrationId: t.Optional(t.Nullable(t.String({ maxLength: 64 }))),
  buyerVatId: t.Optional(t.Nullable(t.String({ maxLength: 64 }))),
  buyerAddressLine1: t.Optional(t.Nullable(t.String({ maxLength: 512 }))),
  buyerAddressLine2: t.Optional(t.Nullable(t.String({ maxLength: 512 }))),
  buyerCity: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
  buyerPostalCode: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
  buyerCountry: t.Optional(t.Nullable(t.String({ maxLength: 128 }))),
});

const BUYER_FIELDS = [
  "buyerName",
  "buyerRegistrationId",
  "buyerVatId",
  "buyerAddressLine1",
  "buyerAddressLine2",
  "buyerCity",
  "buyerPostalCode",
  "buyerCountry",
] as const;

const invoiceParamsSchema = workspaceParams({ invoiceId: tSafeId("invoice") });

type InvoiceUpdateSource = {
  currency: string;
  dueDate: string | null;
  invoiceDate: string;
  invoiceNumber: string;
  notes: string | null;
  reference: string | null;
  sellerProfileId: string | null;
  taxableSupplyDate: string | null;
};

type InvoiceUpdateChanges = Partial<InvoiceUpdateSource>;

type InvoiceUpdateResult =
  | { status: "updated"; id: string }
  | { status: "not-updated" }
  | { status: "currency-has-entries" }
  | { status: "seller-profile-not-found" };

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
  if (changedFields.taxableSupplyDate !== undefined) {
    changes["taxableSupplyDate"] = {
      old: existing.taxableSupplyDate,
      new: changedFields.taxableSupplyDate,
    };
  }
  if (changedFields.sellerProfileId !== undefined) {
    changes["sellerProfileId"] = {
      old: existing.sellerProfileId,
      new: changedFields.sellerProfileId,
    };
  }
  return changes;
};

const updateInvoice = createSafeHandler(
  {
    description:
      "Change a draft invoice's number, issue date (invoiceDate), taxable " +
      "supply date, due date, reference, notes, currency, issuing seller " +
      "profile, or buyer details as they should read on the document. " +
      "Omitted fields stay unchanged; null clears an optional field. Only " +
      "draft invoices can be edited, and the currency cannot change while " +
      "the invoice has lines or attached entries.",
    permissions: { invoice: ["update"] },
    mcp: { type: "capability", reason: "billing_admin" },
    params: invoiceParamsSchema,
    body: updateInvoiceBodySchema,
  },
  async function* ({
    safeDb,
    session,
    workspaceId,
    params,
    body,
    recordAuditEvent,
  }) {
    const changedFields = pickDefined(body, [
      "invoiceNumber",
      "invoiceDate",
      "dueDate",
      "reference",
      "notes",
      "currency",
      "taxableSupplyDate",
      "sellerProfileId",
    ]);
    const changedBuyerFields = pickDefined(body, BUYER_FIELDS);
    const set = {
      ...changedFields,
      ...changedBuyerFields,
      updatedAt: new Date(),
    };

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const existing = await lockInvoiceInStatus(tx, {
          invoiceId: params.invoiceId,
          workspaceId,
          status: INVOICE_STATUS.DRAFT,
        });
        if (!existing) {
          return { status: "not-updated" } satisfies InvoiceUpdateResult;
        }

        const { sellerProfileId } = changedFields;
        if (sellerProfileId !== undefined && sellerProfileId !== null) {
          const [profile] = await tx
            .select({ id: sellerProfiles.id })
            .from(sellerProfiles)
            .where(
              and(
                eq(sellerProfiles.id, sellerProfileId),
                eq(sellerProfiles.organizationId, session.activeOrganizationId),
                isNull(sellerProfiles.archivedAt),
              ),
            )
            .limit(1);
          if (!profile) {
            return {
              status: "seller-profile-not-found",
            } satisfies InvoiceUpdateResult;
          }
        }

        if (
          changedFields.currency !== undefined &&
          changedFields.currency !== existing.currency
        ) {
          const line = await tx
            .select({ id: invoiceLines.id })
            .from(invoiceLines)
            .where(
              and(
                eq(invoiceLines.invoiceId, params.invoiceId),
                eq(invoiceLines.workspaceId, workspaceId),
              ),
            )
            .limit(1);
          if (line.at(0)) {
            return {
              status: "currency-has-entries",
            } satisfies InvoiceUpdateResult;
          }

          const attachedTimeEntry = await tx
            .select({ id: timeEntries.id })
            .from(timeEntries)
            .where(
              and(
                eq(timeEntries.invoiceId, params.invoiceId),
                eq(timeEntries.workspaceId, workspaceId),
              ),
            )
            .limit(1);
          if (attachedTimeEntry.at(0)) {
            return {
              status: "currency-has-entries",
            } satisfies InvoiceUpdateResult;
          }

          const attachedExpense = await tx
            .select({ id: expenses.id })
            .from(expenses)
            .where(
              and(
                eq(expenses.invoiceId, params.invoiceId),
                eq(expenses.workspaceId, workspaceId),
              ),
            )
            .limit(1);
          if (attachedExpense.at(0)) {
            return {
              status: "currency-has-entries",
            } satisfies InvoiceUpdateResult;
          }
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
            // Buyer details are personal data: record which changed, not values.
            metadata: { changedBuyerFields: Object.keys(changedBuyerFields) },
          });
        }
        if (!row) {
          return { status: "not-updated" } satisfies InvoiceUpdateResult;
        }
        return { status: "updated", id: row.id } satisfies InvoiceUpdateResult;
      }),
    );

    if (result.status === "seller-profile-not-found") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Seller profile not found or archived",
        }),
      );
    }
    if (result.status === "currency-has-entries") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invoice currency cannot change while entries are attached",
        }),
      );
    }
    if (result.status === "not-updated") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Invoice not found or not in draft status",
        }),
      );
    }
    return Result.ok({ id: result.id });
  },
);

export default updateInvoice;
