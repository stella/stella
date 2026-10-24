import { panic, Result } from "better-result";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { t } from "elysia";

import { INVOICE_COUNTRY_PROFILES, invoiceCountryOf } from "@stll/invoicing";

import type { Transaction } from "@/api/db/root";
import { resultTx } from "@/api/db/safe-db";
import type { SafeDbError } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  expenses,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
} from "@/api/db/schema";
import type { InvoiceStatus } from "@/api/db/schema";
import { INVOICE_DETAIL_RELATIONS } from "@/api/handlers/invoices/invoice-detail";
import { invoiceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { recordBillingCapCrossings } from "@/api/lib/billing/arrangements";
import { hasActiveInvoiceCredit } from "@/api/lib/billing/invoice-document-type";
import {
  lockDraftInvoiceForLines,
  readInvoiceTotals,
  recalculateInvoiceTotals,
} from "@/api/lib/billing/invoice-lines";
import { invoiceInMatter } from "@/api/lib/billing/invoice-scope";
import {
  allocateNumber,
  findDefaultNumberSeries,
} from "@/api/lib/billing/number-series";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { lockInvoiceInStatus } from "@/api/lib/db/aggregate-lock";
import type {
  AcquiredInvoiceMatterLocks,
  InvoiceMatterLocks,
} from "@/api/lib/db/aggregate-lock";
import { releaseInvoiceTimeEntries } from "@/api/lib/db/transitions";
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
        invoiceInMatter(invoices, workspaceId),
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

const buildVoidEvents = (params: {
  invoiceId: SafeId<"invoice">;
  previousStatus: InvoiceStatus;
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
  matterLocks: AcquiredInvoiceMatterLocks;
  previousStatus: InvoiceStatus;
  now: Date;
  recordAuditEvent: AuditRecorder;
};
const releaseInvoiceEntries = async (
  tx: Transaction,
  {
    matterLocks,
    previousStatus,
    now,
    recordAuditEvent,
  }: ReleaseInvoiceEntriesOptions,
) => {
  const { invoiceId } = matterLocks;
  // The caller retains the successful guard's timer-owner, complete matter
  // and source-row locks; reacquiring them after the invoice would invert order.
  await releaseInvoiceTimeEntries(tx, {
    matterLocks,
    now,
    recordAuditEvent,
  });

  const revertedExpenses = await tx
    .update(expenses)
    .set({
      status: BILLING_STATUS.APPROVED,
      invoiceId: null,
      updatedAt: now,
    })
    .where(and(eq(expenses.invoiceId, invoiceId)))
    .returning({ id: expenses.id });

  // The voided document keeps its lines; releasing them lets the
  // entries they billed go on another invoice.
  await tx
    .update(invoiceLines)
    .set({ releasedAt: now, updatedAt: now })
    .where(
      and(
        eq(invoiceLines.invoiceId, invoiceId),
        isNull(invoiceLines.releasedAt),
      ),
    );

  await recordAuditEvent(
    tx,
    buildVoidEvents({
      invoiceId,
      previousStatus,
      revertedExpenses,
    }),
  );
};

type ReadIssuedInvoiceVatOptions = {
  invoiceId: SafeId<"invoice">;
  workspaceId: SafeId<"workspace">;
};

const readIssuedInvoiceVat = async (
  tx: Transaction,
  { invoiceId, workspaceId }: ReadIssuedInvoiceVatOptions,
) => {
  const invoice = await tx.query.invoices.findFirst({
    where: {
      id: { eq: invoiceId },
      RAW: (table) => invoiceInMatter(table, workspaceId),
    },
    with: INVOICE_DETAIL_RELATIONS,
  });
  if (invoice === undefined) {
    panic("The locked issued invoice disappeared before its totals read");
  }
  return readInvoiceTotals(invoice).vatAmountMinor;
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

type RefreshDraftInvoiceAmountsOptions = {
  scope: Parameters<typeof lockDraftInvoiceForLines>[1];
  now: Date;
  recordAuditEvent: AuditRecorder;
};

const refreshDraftInvoiceAmounts = async (
  tx: Transaction,
  { scope, now, recordAuditEvent }: RefreshDraftInvoiceAmountsOptions,
) => {
  const draft = await lockDraftInvoiceForLines(tx, scope, recordAuditEvent);
  if (draft.isErr()) {
    return Result.err(draft.error);
  }
  const reverseChargeError = await validateReverseChargeBuyer(
    tx,
    scope.invoiceId,
    scope.workspaceId,
  );
  if (reverseChargeError !== null) {
    return Result.err(reverseChargeError);
  }
  return await recalculateInvoiceTotals(tx, scope, now, recordAuditEvent);
};

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
        let matterLocks: InvoiceMatterLocks = { type: "acquire" };
        if (body.action === "void" || body.action === "finalize") {
          const running = await guardRunningTimeEntries({
            tx,
            organizationId: session.activeOrganizationId,
            workspaceId,
            actorUserId: user.id,
            selection: { type: "invoice", invoiceId: params.invoiceId },
          });
          if (running.isErr()) {
            return Result.err(running.error);
          }
          matterLocks = running.value;
        }
        const existing = await lockInvoiceInStatus(tx, {
          invoiceId: params.invoiceId,
          workspaceId,
          status: transition.from,
          matterLocks,
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
          const hasCredit = await hasActiveInvoiceCredit(tx, {
            invoiceId: existing.id,
            workspaceId,
          });
          if (hasCredit) {
            return Result.err(
              new HandlerError({
                status: 409,
                message:
                  "Void linked credit notes before changing their original invoice",
              }),
            );
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
          let vatAmountMinor = existing.vatAmount;
          // Re-finalizing changes status, never the previously issued content.
          if (existing.finalizedAt === null) {
            const totals = await refreshDraftInvoiceAmounts(tx, {
              scope: { ...scope, matterLocks },
              now,
              recordAuditEvent,
            });
            if (totals.isErr()) {
              return Result.err(totals.error);
            }
            vatAmountMinor = totals.value.vatAmountMinor;
          } else {
            vatAmountMinor ??= await readIssuedInvoiceVat(tx, scope);
          }
          const currencyError = await vatCurrencyError({
            tx,
            sellerProfileId: existing.sellerProfileId,
            organizationId: session.activeOrganizationId,
            currency: existing.currency,
            vatAmountMinor,
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
              invoiceInMatter(invoices, workspaceId),
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
          if (matterLocks.type !== "acquired") {
            return panic(
              "Invoice release requires the running guard's acquired locks",
            );
          }
          await releaseInvoiceEntries(tx, {
            matterLocks,
            previousStatus: existing.status,
            now,
            recordAuditEvent,
          });
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
