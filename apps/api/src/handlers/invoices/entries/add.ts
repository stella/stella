import { Result } from "better-result";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { type Static, t } from "elysia";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import { resultTx } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  expenses,
  INVOICE_STATUS,
  timeEntries,
} from "@/api/db/schema";
import {
  ATTACHED_ENTRY_LINE_VAT,
  checkInvoiceLineCapacity,
  expenseLineDraft,
  insertInvoiceLines,
  requireDraftInvoiceForEntryChanges,
  recalculateInvoiceTotals,
  timeEntryLineDraft,
} from "@/api/handlers/invoices/invoice-lines";
import { invoiceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { flatFeeInvoiceRefusal } from "@/api/lib/billing/invoice-arrangements";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { CentsAmount } from "@/api/lib/money";

import { INVOICE_ENTRIES_MODIFIED_MESSAGE } from "../concurrent-modification";

const addEntriesBodySchema = t.Object({
  timeEntryIds: t.Optional(
    t.Array(tSafeId("timeEntry"), { minItems: 1, maxItems: 500 }),
  ),
  expenseIds: t.Optional(
    t.Array(tSafeId("expense"), { minItems: 1, maxItems: 500 }),
  ),
});

const invoiceParamsSchema = workspaceParams({ invoiceId: tSafeId("invoice") });

const buildAttachEvents = (params: {
  invoiceId: SafeId<"invoice">;
  attachedTimeEntries: { id: SafeId<"timeEntry"> }[];
  attachedExpenses: { id: SafeId<"expense"> }[];
}): AuditEvent[] => {
  // The new lines and totals record their own invoice events.
  const events: AuditEvent[] = [
    {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
      resourceId: params.invoiceId,
      changes: {
        attachedTimeEntries: {
          old: null,
          new: params.attachedTimeEntries.map((row) => row.id),
        },
        attachedExpenses: {
          old: null,
          new: params.attachedExpenses.map((row) => row.id),
        },
      },
    },
  ];
  for (const row of params.attachedTimeEntries) {
    events.push({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
      resourceId: row.id,
      changes: {
        status: {
          old: BILLING_STATUS.APPROVED,
          new: BILLING_STATUS.BILLED,
        },
        invoiceId: { old: null, new: params.invoiceId },
      },
    });
  }
  for (const row of params.attachedExpenses) {
    events.push({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.EXPENSE,
      resourceId: row.id,
      changes: {
        status: {
          old: BILLING_STATUS.APPROVED,
          new: BILLING_STATUS.BILLED,
        },
        invoiceId: { old: null, new: params.invoiceId },
      },
    });
  }
  return events;
};

type AttachmentPreflightOptions = {
  invoiceId: SafeId<"invoice">;
  workspaceId: SafeId<"workspace">;
  body: Static<typeof addEntriesBodySchema>;
};
const validateAttachmentInputs = async (
  safeDb: SafeDb,
  { invoiceId, workspaceId, body }: AttachmentPreflightOptions,
) =>
  Result.gen(async function* () {
    if (
      (body.timeEntryIds?.length ?? 0) === 0 &&
      (body.expenseIds?.length ?? 0) === 0
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "At least one time entry or expense ID is required",
        }),
      );
    }

    const invoice = yield* Result.await(
      safeDb((tx) =>
        tx.query.invoices.findFirst({
          where: {
            id: { eq: invoiceId },
            workspaceId: { eq: workspaceId },
          },
          columns: {
            id: true,
            status: true,
            currency: true,
            documentType: true,
            billingMode: true,
          },
        }),
      ),
    );

    if (!invoice) {
      return Result.err(
        new HandlerError({ status: 404, message: "Invoice not found" }),
      );
    }

    if (invoice.status !== INVOICE_STATUS.DRAFT) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Entries can only be added to draft invoices",
        }),
      );
    }

    if (invoice.billingMode === "flat_fee") {
      return Result.err(flatFeeInvoiceRefusal());
    }

    if (invoice.documentType === "credit_note") {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Credit notes cannot bill time entries or expenses",
        }),
      );
    }

    const timeEntryIds = body.timeEntryIds;
    if (timeEntryIds && timeEntryIds.length > 0) {
      const entries = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({
              id: timeEntries.id,
              status: timeEntries.status,
              billable: timeEntries.billable,
              invoiceId: timeEntries.invoiceId,
              currency: timeEntries.currency,
            })
            .from(timeEntries)
            .where(
              and(
                eq(timeEntries.workspaceId, workspaceId),
                eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.CLIENT),
                inArray(timeEntries.id, timeEntryIds),
              ),
            ),
        ),
      );

      if (entries.length !== timeEntryIds.length) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Some time entries were not found",
          }),
        );
      }

      const invalid = entries.some(
        (entry) =>
          entry.status !== BILLING_STATUS.APPROVED ||
          !entry.billable ||
          entry.currency === UNPRICED_TIME_ENTRY_CURRENCY ||
          entry.invoiceId !== null,
      );
      if (invalid) {
        return Result.err(
          new HandlerError({
            status: 400,
            message:
              "All time entries must be approved, billable," +
              " and not already on an invoice",
          }),
        );
      }

      if (entries.some((entry) => entry.currency !== invoice.currency)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "All time entries must match the invoice currency",
          }),
        );
      }
    }

    const expenseIds = body.expenseIds;
    if (expenseIds && expenseIds.length > 0) {
      const expenseRows = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({
              id: expenses.id,
              status: expenses.status,
              billable: expenses.billable,
              invoiceId: expenses.invoiceId,
              currency: expenses.currency,
            })
            .from(expenses)
            .where(
              and(
                eq(expenses.workspaceId, workspaceId),
                inArray(expenses.id, expenseIds),
              ),
            ),
        ),
      );

      if (expenseRows.length !== expenseIds.length) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Some expenses were not found",
          }),
        );
      }

      const invalid = expenseRows.some(
        (expense) =>
          expense.status !== BILLING_STATUS.APPROVED ||
          !expense.billable ||
          expense.invoiceId !== null,
      );
      if (invalid) {
        return Result.err(
          new HandlerError({
            status: 400,
            message:
              "All expenses must be approved, billable," +
              " and not already on an invoice",
          }),
        );
      }

      if (
        expenseRows.some((expense) => expense.currency !== invoice.currency)
      ) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "All expenses must match the invoice currency",
          }),
        );
      }
    }

    return Result.ok(undefined);
  });

const addEntries = createSafeHandler(
  {
    description:
      "Attach approved, billable, not-yet-invoiced time entries and expenses " +
      "to a draft invoice as invoice lines without VAT, marking them billed " +
      "and recomputing the invoice totals. Every entry must match the " +
      "invoice currency, because an invoice is single-currency and nothing " +
      "is converted. Only draft " +
      "invoices accept entries, and a concurrent change to the same entries " +
      "fails with a retryable conflict rather than attaching part of the " +
      "set.",
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
    body: addEntriesBodySchema,
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
    yield* Result.await(
      validateAttachmentInputs(safeDb, {
        invoiceId: params.invoiceId,
        workspaceId,
        body,
      }),
    );
    const now = new Date();
    const { timeEntryIds, expenseIds } = body;

    const entryChangeScope = {
      invoiceId: params.invoiceId,
      organizationId: session.activeOrganizationId,
      workspaceId,
      recordAuditEvent,
      conflictMessage: INVOICE_ENTRIES_MODIFIED_MESSAGE,
    };

    const txResult = await resultTx(safeDb, async (tx) => {
      const runningError = await guardRunningTimeEntries({
        tx,
        workspaceId,
        actorUserId: user.id,
        selection: body.timeEntryIds
          ? { type: "entries", ids: body.timeEntryIds }
          : { type: "none" },
      });
      if (runningError) {
        return Result.err(runningError);
      }
      const invoiceResult = await requireDraftInvoiceForEntryChanges(
        tx,
        entryChangeScope,
      );
      if (invoiceResult.isErr()) {
        return Result.err(invoiceResult.error);
      }
      const invoiceCheck = invoiceResult.value;
      if (invoiceCheck.billingMode === "flat_fee") {
        return Result.err(flatFeeInvoiceRefusal());
      }
      if (invoiceCheck.documentType === "credit_note") {
        return Result.err(
          new HandlerError({
            status: 422,
            message: "Credit notes cannot bill time entries or expenses",
          }),
        );
      }
      // Refused before any entry is claimed, so nothing partial commits.
      const capacity = await checkInvoiceLineCapacity(
        tx,
        { invoiceId: params.invoiceId, workspaceId },
        (timeEntryIds?.length ?? 0) + (expenseIds?.length ?? 0),
      );
      if (capacity.isErr()) {
        return Result.err(capacity.error);
      }

      let attachedTimeEntries: {
        id: SafeId<"timeEntry">;
        billedMinutes: number;
        rateAtEntry: CentsAmount;
        narrative: string;
        invoiceNarrative: string | null;
        noCharge: boolean;
      }[] = [];
      if (timeEntryIds && timeEntryIds.length > 0) {
        attachedTimeEntries = await tx
          .update(timeEntries)
          .set({
            invoiceId: params.invoiceId,
            status: BILLING_STATUS.BILLED,
            updatedAt: now,
          })
          .where(
            and(
              eq(timeEntries.workspaceId, workspaceId),
              eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.CLIENT),
              inArray(timeEntries.id, timeEntryIds),
              eq(timeEntries.status, BILLING_STATUS.APPROVED),
              eq(timeEntries.billable, true),
              isNull(timeEntries.invoiceId),
              // Re-check currency under the claim so a concurrent edit
              // cannot attach a mismatched-currency entry (count mismatch
              // then trips the concurrent-modification retry path).
              eq(timeEntries.currency, invoiceCheck.currency),
            ),
          )
          .returning({
            id: timeEntries.id,
            billedMinutes: timeEntries.billedMinutes,
            rateAtEntry: timeEntries.rateAtEntry,
            narrative: timeEntries.narrative,
            invoiceNarrative: timeEntries.invoiceNarrative,
            noCharge: timeEntries.noCharge,
          });

        if (attachedTimeEntries.length !== timeEntryIds.length) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: INVOICE_ENTRIES_MODIFIED_MESSAGE,
            }),
          );
        }
      }

      let attachedExpenses: {
        id: SafeId<"expense">;
        amount: CentsAmount;
        markup: number;
        description: string;
        invoiceDescription: string | null;
      }[] = [];
      if (expenseIds && expenseIds.length > 0) {
        attachedExpenses = await tx
          .update(expenses)
          .set({
            invoiceId: params.invoiceId,
            status: BILLING_STATUS.BILLED,
            updatedAt: now,
          })
          .where(
            and(
              eq(expenses.workspaceId, workspaceId),
              inArray(expenses.id, expenseIds),
              eq(expenses.status, BILLING_STATUS.APPROVED),
              eq(expenses.billable, true),
              isNull(expenses.invoiceId),
              eq(expenses.currency, invoiceCheck.currency),
            ),
          )
          .returning({
            id: expenses.id,
            amount: expenses.amount,
            markup: expenses.markup,
            description: expenses.description,
            invoiceDescription: expenses.invoiceDescription,
          });

        if (attachedExpenses.length !== expenseIds.length) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: INVOICE_ENTRIES_MODIFIED_MESSAGE,
            }),
          );
        }
      }

      const scope = { invoiceId: params.invoiceId, workspaceId };
      await insertInvoiceLines(
        tx,
        { ...scope, organizationId: session.activeOrganizationId },
        [
          ...attachedTimeEntries.map((entry) =>
            timeEntryLineDraft(entry, ATTACHED_ENTRY_LINE_VAT),
          ),
          ...attachedExpenses.map((expense) =>
            expenseLineDraft(expense, ATTACHED_ENTRY_LINE_VAT),
          ),
        ],
        { recordAuditEvent },
      );
      const totals = await recalculateInvoiceTotals(
        tx,
        scope,
        now,
        recordAuditEvent,
      );
      if (totals.isErr()) {
        return Result.err(totals.error);
      }
      const totalAmount = totals.value.grossAmountMinor;

      await recordAuditEvent(
        tx,
        buildAttachEvents({
          invoiceId: params.invoiceId,
          attachedTimeEntries,
          attachedExpenses,
        }),
      );

      return Result.ok({ totalAmount });
    });

    if (txResult.isErr()) {
      return Result.err(txResult.error);
    }

    return Result.ok({ totalAmount: txResult.value.totalAmount });
  },
);

export default addEntries;
