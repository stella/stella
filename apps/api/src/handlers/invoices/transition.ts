import { Result } from "better-result";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { t } from "elysia";

import { INVOICE_COUNTRY_PROFILES, invoiceCountryOf } from "@stll/invoicing";

import type { Transaction } from "@/api/db/root";
import { resultTx } from "@/api/db/safe-db";
import type { SafeDbError } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  expenses,
  INVOICE_ATTACHMENT,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import type { InvoiceStatus } from "@/api/db/schema";
import {
  lockDraftInvoiceForLines,
  recalculateInvoiceTotals,
} from "@/api/handlers/invoices/invoice-lines";
import { lockInvoiceInStatus } from "@/api/handlers/invoices/lock-invoice";
import { invoiceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { recordBillingCapCrossings } from "@/api/lib/billing/arrangements";
import {
  allocateNumber,
  findDefaultNumberSeries,
} from "@/api/lib/billing/number-series";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";

type TransitionAction =
  "finalize" | "send" | "mark_paid" | "void" | "revert_to_draft";

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

const transitionInvoiceBodySchema = t.Object({
  action: t.UnionEnum([
    "finalize",
    "send",
    "mark_paid",
    "void",
    "revert_to_draft",
  ]),
});

const invoiceParamsSchema = workspaceParams({ invoiceId: tSafeId("invoice") });

const validateReverseChargeBuyer = async (
  tx: Transaction,
  invoiceId: SafeId<"invoice">,
  workspaceId: SafeId<"workspace">,
) => {
  const rows = await tx
    .select({ id: invoiceLines.id, buyerVatId: invoices.buyerVatId })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(
      and(
        eq(invoiceLines.invoiceId, invoiceId),
        eq(invoiceLines.workspaceId, workspaceId),
        eq(invoiceLines.vatTreatment, "reverse_charge"),
      ),
    )
    .limit(1);
  const reverseCharge = rows.at(0);
  return reverseCharge !== undefined &&
    (reverseCharge.buyerVatId ?? "").trim() === ""
    ? new HandlerError({
        status: 400,
        message: "Reverse charge requires a buyer VAT ID",
      })
    : null;
};

type PolishExemptionBasisOptions = {
  tx: Transaction;
  invoiceId: SafeId<"invoice">;
  workspaceId: SafeId<"workspace">;
  sellerProfileId: SafeId<"sellerProfile"> | null;
  organizationId: SafeId<"organization">;
};

const validatePolishExemptionBases = async ({
  tx,
  invoiceId,
  workspaceId,
  sellerProfileId,
  organizationId,
}: PolishExemptionBasisOptions) => {
  if (sellerProfileId === null) {
    return null;
  }
  const seller = await tx.query.sellerProfiles.findFirst({
    where: {
      id: { eq: sellerProfileId },
      organizationId: { eq: organizationId },
    },
    columns: { country: true, vatId: true },
  });
  if (seller === undefined || invoiceCountryOf(seller) !== "PL") {
    return null;
  }
  const missing = await tx
    .select({ treatment: invoiceLines.vatTreatment })
    .from(invoiceLines)
    .where(
      and(
        eq(invoiceLines.invoiceId, invoiceId),
        eq(invoiceLines.workspaceId, workspaceId),
        inArray(invoiceLines.vatTreatment, ["exempt", "not_vat_payer"]),
        // The line schemas refuse blank bases (tExemptionReason).
        isNull(invoiceLines.exemptionReason),
      ),
    )
    .limit(1);
  const line = missing.at(0);
  return line === undefined
    ? null
    : new HandlerError({
        status: 400,
        message: `Polish ${line.treatment} invoice lines require an exemption basis`,
        hint: "Add the statutory exemption reason to every exempt or non-VAT-payer line, then finalize again.",
      });
};

type FinalizeTaxRequirementsOptions = PolishExemptionBasisOptions;

const validateFinalizeTaxRequirements = async (
  options: FinalizeTaxRequirementsOptions,
) =>
  (await validateReverseChargeBuyer(
    options.tx,
    options.invoiceId,
    options.workspaceId,
  )) ?? (await validatePolishExemptionBases(options));

const linkedCreditError = async (
  tx: Transaction,
  invoiceId: SafeId<"invoice">,
  workspaceId: SafeId<"workspace">,
) => {
  const credit = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.workspaceId, workspaceId),
        eq(invoices.originalInvoiceId, invoiceId),
        ne(invoices.status, INVOICE_STATUS.VOID),
      ),
    )
    .limit(1);
  return credit.at(0)
    ? new HandlerError({
        status: 409,
        message:
          "Void linked credit notes before changing their original invoice",
      })
    : null;
};

const buildVoidEvents = (params: {
  invoiceId: SafeId<"invoice">;
  previousStatus: InvoiceStatus;
  revertedTimeEntries: { id: SafeId<"timeEntry"> }[];
  revertedExpenses: { id: SafeId<"expense"> }[];
}): AuditEvent[] => {
  const events: AuditEvent[] = [
    {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
      resourceId: params.invoiceId,
      changes: {
        status: { old: params.previousStatus, new: INVOICE_STATUS.VOID },
      },
    },
  ];
  for (const row of params.revertedTimeEntries) {
    events.push({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
      resourceId: row.id,
      changes: {
        status: {
          old: BILLING_STATUS.BILLED,
          new: BILLING_STATUS.APPROVED,
        },
        invoiceId: { old: params.invoiceId, new: null },
      },
    });
  }
  for (const row of params.revertedExpenses) {
    events.push({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.EXPENSE,
      resourceId: row.id,
      changes: {
        status: {
          old: BILLING_STATUS.BILLED,
          new: BILLING_STATUS.APPROVED,
        },
        invoiceId: { old: params.invoiceId, new: null },
      },
    });
  }
  return events;
};

type ReleaseInvoiceEntriesOptions = {
  actorUserId: SafeId<"user">;
  invoiceId: SafeId<"invoice">;
  workspaceId: SafeId<"workspace">;
  previousStatus: InvoiceStatus;
  now: Date;
  recordAuditEvent: AuditRecorder;
};
const releaseInvoiceEntries = async (
  tx: Transaction,
  {
    invoiceId,
    workspaceId,
    previousStatus,
    now,
    recordAuditEvent,
    actorUserId,
  }: ReleaseInvoiceEntriesOptions,
) => {
  // The caller acquires these locks before the invoice; guard the release too.
  const runningError = await guardRunningTimeEntries({
    tx,
    workspaceId,
    actorUserId,
    selection: { type: "invoice", invoiceId },
  });
  if (runningError) {
    return Result.err(runningError);
  }
  const revertedTimeEntries = await tx
    .update(timeEntries)
    .set({
      status: BILLING_STATUS.APPROVED,
      invoiceId: null,
      invoiceAttachment: INVOICE_ATTACHMENT.CHARGED,
      updatedAt: now,
    })
    .where(
      and(
        eq(timeEntries.invoiceId, invoiceId),
        eq(timeEntries.workspaceId, workspaceId),
      ),
    )
    .returning({ id: timeEntries.id });

  const revertedExpenses = await tx
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
    )
    .returning({ id: expenses.id });

  // The voided document keeps its lines; releasing them lets the
  // entries they billed go on another invoice.
  await tx
    .update(invoiceLines)
    .set({ releasedAt: now, updatedAt: now })
    .where(
      and(
        eq(invoiceLines.invoiceId, invoiceId),
        eq(invoiceLines.workspaceId, workspaceId),
        isNull(invoiceLines.releasedAt),
      ),
    );

  await recordAuditEvent(
    tx,
    buildVoidEvents({
      invoiceId,
      previousStatus,
      revertedTimeEntries,
      revertedExpenses,
    }),
  );
  return Result.ok(undefined);
};

type VatCurrencyGuardOptions = {
  tx: Transaction;
  sellerProfileId: SafeId<"sellerProfile"> | null;
  organizationId: SafeId<"organization">;
  currency: string;
  vatAmountMinor: number;
};

const vatCurrencyError = async ({
  tx,
  sellerProfileId,
  organizationId,
  currency,
  vatAmountMinor,
}: VatCurrencyGuardOptions): Promise<HandlerError | null> => {
  if (vatAmountMinor === 0 || sellerProfileId === null) {
    return null;
  }
  const seller = await tx.query.sellerProfiles.findFirst({
    where: {
      id: { eq: sellerProfileId },
      organizationId: { eq: organizationId },
    },
    columns: { country: true, vatId: true },
  });
  if (seller === undefined) {
    return null;
  }
  const { vatCurrency } = INVOICE_COUNTRY_PROFILES[invoiceCountryOf(seller)];
  if (vatCurrency === null || vatCurrency === currency) {
    return null;
  }
  return new HandlerError({
    status: 409,
    message: `This seller's VAT invoices must state the VAT amount in ${vatCurrency}`,
    hint: `Issue the invoice in ${vatCurrency}; converting the VAT amount from another currency is not supported yet.`,
  });
};

/** A finalize that reuses an issued number surfaces as a conflict. */
const duplicateInvoiceNumberError = (
  error: HandlerError | SafeDbError,
): HandlerError | null =>
  DatabaseError.is(error) && error.code === PG_ERROR.UNIQUE_VIOLATION
    ? new HandlerError({
        status: 409,
        message: "An invoice with this number already exists",
      })
    : null;

const transitionInvoice = createSafeHandler(
  {
    contract: "patch",
    description:
      "Move an invoice through finalize, send, mark_paid, void, or revert_to_draft. " +
      "Finalize assigns an omitted number from the document type's default series, " +
      "using the issue date; configure a default number series first. Manual numbers " +
      "and numbers kept after reverting to draft are preserved. A credit note must " +
      "reference an eligible original and cannot exceed its total. Voiding releases " +
      "attached entries and clears the paid timestamp. A VAT invoice must use the " +
      "currency its seller's country requires for the VAT amount (EUR for Slovakia, " +
      "CZK for Czechia).",
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
    body: transitionInvoiceBodySchema,
  },
  async function* ({
    safeDb,
    user,
    session,
    workspaceId,
    params,
    body,
    recordAuditEvent,
  }) {
    const transition = TRANSITIONS[body.action];
    const now = new Date();
    const result = await resultTx(
      safeDb,
      async (tx): Promise<Result<{ id: SafeId<"invoice"> }, HandlerError>> => {
        if (body.action === "void" || body.action === "finalize") {
          const runningError = await guardRunningTimeEntries({
            tx,
            workspaceId,
            actorUserId: user.id,
            selection: { type: "invoice", invoiceId: params.invoiceId },
          });
          if (runningError) {
            return Result.err(runningError);
          }
        }
        const existing = await lockInvoiceInStatus(tx, {
          invoiceId: params.invoiceId,
          workspaceId,
          status: transition.from,
        });
        if (!existing) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: `Cannot ${body.action} invoice from its current status`,
            }),
          );
        }
        if (body.action === "void" || body.action === "revert_to_draft") {
          const creditError = await linkedCreditError(
            tx,
            existing.id,
            workspaceId,
          );
          if (creditError !== null) {
            return Result.err(creditError);
          }
        }
        const set: Partial<typeof invoices.$inferInsert> = {
          status: transition.to,
          updatedAt: now,
        };
        if (body.action === "mark_paid") {
          set.paidAt = now;
        }
        if (body.action === "void") {
          set.paidAt = null;
        }
        if (body.action === "revert_to_draft") {
          set.finalizedAt = existing.finalizedAt ?? now;
        }
        if (body.action === "finalize") {
          const scope = {
            invoiceId: existing.id,
            workspaceId,
            organizationId: session.activeOrganizationId,
          };
          const draft = await lockDraftInvoiceForLines(
            tx,
            scope,
            recordAuditEvent,
          );
          if (draft.isErr()) {
            return Result.err(draft.error);
          }
          const taxRequirementsError = await validateFinalizeTaxRequirements({
            tx,
            invoiceId: existing.id,
            workspaceId,
            sellerProfileId: existing.sellerProfileId,
            organizationId: session.activeOrganizationId,
          });
          if (taxRequirementsError !== null) {
            return Result.err(taxRequirementsError);
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
          const currencyError = await vatCurrencyError({
            tx,
            sellerProfileId: existing.sellerProfileId,
            organizationId: session.activeOrganizationId,
            currency: existing.currency,
            vatAmountMinor: totals.value.vatAmountMinor,
          });
          if (currencyError !== null) {
            return Result.err(currencyError);
          }
          set.finalizedAt = existing.finalizedAt ?? now;
          if (existing.invoiceNumber === null) {
            const series = await findDefaultNumberSeries(
              tx,
              existing.documentType,
              existing.sellerProfileId,
            );
            if (!series) {
              return Result.err(
                new HandlerError({
                  status: 409,
                  message:
                    "No default number series configured for this document type",
                  hint: "Create a number series for this documentType and this seller or all sellers, set it as default, then finalize again.",
                }),
              );
            }
            const number = await allocateNumber(
              tx,
              series.id,
              new Date(`${existing.invoiceDate}T00:00:00Z`),
            );
            if (number.isErr()) {
              return Result.err(number.error);
            }
            set.invoiceNumber = number.value.number;
          }
        }
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
        const row = updated.at(0);
        if (!row) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: `Cannot ${body.action} invoice from its current status`,
            }),
          );
        }
        if (body.action === "void") {
          const release = await releaseInvoiceEntries(tx, {
            actorUserId: user.id,
            invoiceId: row.id,
            workspaceId,
            previousStatus: existing.status,
            now,
            recordAuditEvent,
          });
          if (release.isErr()) {
            return Result.err(release.error);
          }
          await recordBillingCapCrossings(tx, {
            workspaceId,
            recordAuditEvent,
          });
        } else {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
            resourceId: row.id,
            changes: {
              status: { old: existing.status, new: transition.to },
              action: { old: null, new: body.action },
              ...(set.invoiceNumber !== undefined
                ? {
                    invoiceNumber: {
                      old: existing.invoiceNumber,
                      new: set.invoiceNumber,
                    },
                  }
                : {}),
            },
          });
        }
        return Result.ok({ id: row.id });
      },
    );
    const conflict = result.isErr()
      ? duplicateInvoiceNumberError(result.error)
      : null;
    if (conflict !== null) {
      return Result.err(conflict);
    }
    const transitioned = yield* result;
    return Result.ok(transitioned);
  },
);

export default transitionInvoice;
