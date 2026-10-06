import { Result } from "better-result";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { t } from "elysia";

import { INVOICE_LINE_SOURCE } from "@stll/api-contract";
import type { InvoiceDocumentType } from "@stll/invoicing";

import type { Transaction } from "@/api/db/root";
import { resultTx } from "@/api/db/safe-db";
import {
  expenses,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
  sellerProfiles,
  timeEntries,
} from "@/api/db/schema";
import { lockInvoiceInStatus } from "@/api/handlers/invoices/lock-invoice";
import { invoiceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { FieldDiffs } from "@/api/lib/audit-log";
import { flatFeeInvoiceRefusal } from "@/api/lib/billing/invoice-arrangements";
import type { SafeId } from "@/api/lib/branded-types";
import {
  tCurrencyCode,
  tSafeId,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { pickDefined } from "@/api/lib/pick-defined";

import { tInvoiceDocumentType, validateInvoiceDocument } from "./document-type";
import { recalculateInvoiceTotals } from "./invoice-lines";

const updateInvoiceBodySchema = t.Object({
  invoiceNumber: t.Optional(
    t.Nullable(t.String({ minLength: 1, maxLength: 64 })),
  ),
  documentType: t.Optional(tInvoiceDocumentType),
  originalInvoiceId: t.Optional(t.Nullable(tSafeId("invoice"))),
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
  invoiceNumber: string | null;
  documentType: InvoiceDocumentType;
  originalInvoiceId: string | null;
  notes: string | null;
  reference: string | null;
  sellerProfileId: string | null;
  taxableSupplyDate: string | null;
};

type InvoiceUpdateChanges = Partial<InvoiceUpdateSource>;

type InvoiceUpdateResult =
  | { status: "updated"; id: SafeId<"invoice"> }
  | { status: "not-updated" }
  | { status: "currency-has-entries" }
  | { status: "seller-profile-not-found" };

const buildInvoiceUpdateAuditChanges = (
  existing: InvoiceUpdateSource,
  changedFields: InvoiceUpdateChanges,
): FieldDiffs => {
  const changes: FieldDiffs = {};
  for (const field of ["documentType", "originalInvoiceId"] as const) {
    if (changedFields[field] !== undefined) {
      changes[field] = { old: existing[field], new: changedFields[field] };
    }
  }
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

type InvoiceEntriesScope = {
  invoiceId: SafeId<"invoice">;
  workspaceId: SafeId<"workspace">;
  lines: "all" | "entry-sourced";
};
const invoiceHasEntries = async (
  tx: Transaction,
  { invoiceId, workspaceId, lines }: InvoiceEntriesScope,
) => {
  const line = await tx
    .select({ id: invoiceLines.id })
    .from(invoiceLines)
    .where(
      and(
        eq(invoiceLines.invoiceId, invoiceId),
        eq(invoiceLines.workspaceId, workspaceId),
        lines === "entry-sourced"
          ? ne(invoiceLines.source, INVOICE_LINE_SOURCE.MANUAL)
          : undefined,
      ),
    )
    .limit(1);
  if (line.at(0)) {
    return true;
  }

  const attachedTimeEntry = await tx
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.invoiceId, invoiceId),
        eq(timeEntries.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (attachedTimeEntry.at(0)) {
    return true;
  }

  const attachedExpense = await tx
    .select({ id: expenses.id })
    .from(expenses)
    .where(
      and(
        eq(expenses.invoiceId, invoiceId),
        eq(expenses.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (attachedExpense.at(0)) {
    return true;
  }
  return false;
};

type SellerProfileAvailabilityOptions = {
  sellerProfileId: SafeId<"sellerProfile">;
  organizationId: SafeId<"organization">;
};
const sellerProfileIsAvailable = async (
  tx: Transaction,
  { sellerProfileId, organizationId }: SellerProfileAvailabilityOptions,
) => {
  const [profile] = await tx
    .select({ id: sellerProfiles.id })
    .from(sellerProfiles)
    .where(
      and(
        eq(sellerProfiles.id, sellerProfileId),
        eq(sellerProfiles.organizationId, organizationId),
        isNull(sellerProfiles.archivedAt),
      ),
    )
    .limit(1);
  return profile !== undefined;
};

const updateInvoice = createSafeHandler(
  {
    description:
      "Change a draft invoice's number, issue date (invoiceDate), taxable " +
      "supply date, due date, reference, notes, currency, issuing seller " +
      "profile, or buyer details as they should read on the document. " +
      "Omitted fields stay unchanged; null clears an optional field. Only " +
      "draft invoices can be edited. Type and original invoice become immutable " +
      "after the first finalize, including after reverting to draft. Credit notes " +
      "require an eligible original in the same matter. Currency cannot change while " +
      "the invoice has lines or attached entries.",
    permissions: { invoice: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: invoiceRealtimeUpdates,
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
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
      "documentType",
      "originalInvoiceId",
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
      resultTx(
        safeDb,
        async (tx): Promise<Result<InvoiceUpdateResult, HandlerError>> => {
          const existing = await lockInvoiceInStatus(tx, {
            invoiceId: params.invoiceId,
            workspaceId,
            status: INVOICE_STATUS.DRAFT,
          });
          if (!existing) {
            return Result.ok({ status: "not-updated" });
          }

          const documentType =
            changedFields.documentType ?? existing.documentType;
          if (
            existing.billingMode === "flat_fee" &&
            documentType !== "invoice"
          ) {
            return Result.err(flatFeeInvoiceRefusal());
          }
          const originalInvoiceId =
            changedFields.originalInvoiceId === undefined
              ? existing.originalInvoiceId
              : changedFields.originalInvoiceId;
          if (
            existing.finalizedAt !== null &&
            (documentType !== existing.documentType ||
              originalInvoiceId !== existing.originalInvoiceId ||
              (changedFields.invoiceNumber !== undefined &&
                changedFields.invoiceNumber !== existing.invoiceNumber))
          ) {
            return Result.err(
              new HandlerError({
                status: 409,
                message:
                  "Document type, original invoice, and assigned number cannot be cleared or changed after finalize",
              }),
            );
          }
          if (
            documentType === "credit_note" &&
            documentType !== existing.documentType &&
            (await invoiceHasEntries(tx, {
              invoiceId: params.invoiceId,
              workspaceId,
              lines: "entry-sourced",
            }))
          ) {
            return Result.err(
              new HandlerError({
                status: 422,
                message: "Credit notes cannot bill time entries or expenses",
              }),
            );
          }
          const valid = await validateInvoiceDocument(tx, {
            invoiceId: params.invoiceId,
            workspaceId,
            documentType,
            originalInvoiceId,
            currency: changedFields.currency ?? existing.currency,
            totalAmount: existing.totalAmount,
          });
          if (valid.isErr()) {
            return Result.err(valid.error);
          }

          const { sellerProfileId } = changedFields;
          if (sellerProfileId !== undefined && sellerProfileId !== null) {
            const profile = await sellerProfileIsAvailable(tx, {
              sellerProfileId,
              organizationId: session.activeOrganizationId,
            });
            if (!profile) {
              return Result.ok({ status: "seller-profile-not-found" });
            }
          }

          if (
            changedFields.currency !== undefined &&
            changedFields.currency !== existing.currency &&
            (await invoiceHasEntries(tx, {
              invoiceId: params.invoiceId,
              workspaceId,
              lines: "all",
            }))
          ) {
            return Result.ok({ status: "currency-has-entries" });
          }

          const signChanged =
            (documentType === "credit_note") !==
            (existing.documentType === "credit_note");
          if (signChanged) {
            await tx
              .update(invoiceLines)
              .set({
                netAmount: sql`-${invoiceLines.netAmount}`,
                vatAmount: sql`-${invoiceLines.vatAmount}`,
                grossAmount: sql`-${invoiceLines.grossAmount}`,
                updatedAt: set.updatedAt,
              })
              .where(
                and(
                  eq(invoiceLines.invoiceId, params.invoiceId),
                  eq(invoiceLines.workspaceId, workspaceId),
                ),
              );
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

          if (signChanged) {
            const totals = await recalculateInvoiceTotals(
              tx,
              { invoiceId: params.invoiceId, workspaceId },
              set.updatedAt,
              recordAuditEvent,
            );
            if (totals.isErr()) {
              return Result.err(totals.error);
            }
          }
          const row = updated.at(0);
          if (!row) {
            return Result.ok({ status: "not-updated" });
          }
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
            resourceId: row.id,
            changes: buildInvoiceUpdateAuditChanges(existing, changedFields),
            // Buyer details are personal data: record which changed, not values.
            metadata: { changedBuyerFields: Object.keys(changedBuyerFields) },
          });
          return Result.ok({ status: "updated", id: row.id });
        },
      ),
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
