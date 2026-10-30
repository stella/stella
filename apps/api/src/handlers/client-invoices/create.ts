import { Result } from "better-result";
import { and, eq, inArray, max } from "drizzle-orm";
import * as v from "valibot";

import { resultTx } from "@/api/db/safe-db";
import { expenses, invoices, timeEntries } from "@/api/db/schema";
import { invoiceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  createDraftInvoice,
  createInvoiceInput,
  invoiceCreationError,
} from "@/api/lib/billing/invoice-create-operation";
import {
  matterInvoiceCount,
  matterInvoiceLimitRefusal,
  recalculateInvoiceTotals,
} from "@/api/lib/billing/invoice-lines";
import { latestDate } from "@/api/lib/billing/invoice-prefill.logic";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import {
  lockBillingArrangement,
  withInvoiceMatterLocks,
} from "@/api/lib/db/aggregate-lock";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

import { appendClientInvoiceMatter } from "./append-matter";
import { clientInvoiceBody } from "./create-contract";
import {
  resolveClientInvoiceMatters,
  validateClientInvoiceSelection,
} from "./selection";

const createClientInvoice = createSafeRootHandler(
  {
    contract: "patch",
    idempotency: { type: "replay" },
    description: `Create one client draft from approved unbilled hourly work across selected matters. Every matter must belong to the client and be accessible. No partial invoice is returned. At most ${LIMITS.invoiceLinesPerInvoice} lines across ${LIMITS.clientInvoiceMatters} matters. Select the returned workspaceId as the matterId for invoices.get, finalize and PDF export. For line edits, use that line's workspaceId from invoices.get. Line overrides edit the invoice only, through invoices.lines.update.`,
    permissions: { invoice: ["create"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    realtime: invoiceRealtimeUpdates,
    params: v.object({ clientId: resourceIdSchema("contact") }),
    body: clientInvoiceBody,
  },
  async function* ({
    safeDb,
    session,
    user,
    memberRole,
    params,
    body,
    recordAuditEvent,
  }) {
    const { matters, expectedTotalAmount, ...details } = body;
    const { ids, first } = yield* validateClientInvoiceSelection(matters);
    const result = await resultTx(safeDb, async (tx) => {
      // Acquire every timer-owner lock before matter locks; each later per-matter guard checks running state.
      const sourceLocks = await guardRunningTimeEntries({
        tx,
        organizationId: session.activeOrganizationId,
        additionalWorkspaceIds: ids,
        actorUserId: user.id,
        selection: {
          type: "approval_batch",
          ids: matters.flatMap((m) => m.timeEntryIds),
        },
      });
      if (sourceLocks) {
        return Result.err(sourceLocks);
      }
      await withInvoiceMatterLocks(tx, ids);
      // Serialize client matter membership and arrangement changes before claiming work.
      const selected = await resolveClientInvoiceMatters(tx, {
        organizationId: session.activeOrganizationId,
        clientId: params.clientId,
        workspaceIds: ids,
      });
      if (selected.isErr()) {
        return selected;
      }
      for (const matter of selected.value) {
        // Refuse before any write. insertInvoiceLines enforces the same quota
        // on every path that adds a matter to an invoice.
        // db-await-in-loop: at most 50 matter arrangements, locked in stable ID order
        const totalInvoices = await matterInvoiceCount(tx, matter.id);
        if (totalInvoices >= LIMITS.invoicesPerWorkspace) {
          return Result.err(matterInvoiceLimitRefusal());
        }
        // db-await-in-loop: at most 50 matter arrangements, locked in stable ID order
        const arrangement = await lockBillingArrangement(tx, matter.id);
        if (arrangement?.mode === "flat_fee") {
          return Result.err(
            new HandlerError({
              status: 409,
              message: "Bill flat-fee matters on their own invoice",
              hint: "Create a single-matter invoice for the agreed fee.",
            }),
          );
        }
      }
      const now = new Date();
      const timeIds = matters.flatMap((m) => m.timeEntryIds);
      const expenseIds = matters.flatMap((m) => m.expenseIds);
      const [timeDate, expenseDate] = await Promise.all([
        tx
          .select({ date: max(timeEntries.dateWorked) })
          .from(timeEntries)
          .where(
            and(
              inArray(timeEntries.id, timeIds),
              inArray(timeEntries.workspaceId, ids),
              eq(timeEntries.organizationId, session.activeOrganizationId),
            ),
          ),
        tx
          .select({ date: max(expenses.dateIncurred) })
          .from(expenses)
          .where(
            and(
              inArray(expenses.id, expenseIds),
              inArray(expenses.workspaceId, ids),
              eq(expenses.organizationId, session.activeOrganizationId),
            ),
          ),
      ]);
      const supplyDate =
        details.taxableSupplyDate ??
        latestDate(
          [timeDate.at(0)?.date, expenseDate.at(0)?.date].filter(
            (date): date is string => date !== null && date !== undefined,
          ),
          details.invoiceDate,
        );
      const invoiceDetails = { ...details, taxableSupplyDate: supplyDate };
      const made = await createDraftInvoice(tx, {
        actorUserId: user.id,
        memberRole,
        organizationId: session.activeOrganizationId,
        workspaceId: first.workspaceId,
        clientId: params.clientId,
        body: createInvoiceInput({
          ...invoiceDetails,
          timeEntryIds: [...first.timeEntryIds],
          expenseIds: [...first.expenseIds],
        }),
        now,
        recordAuditEvent,
      });
      if (made.isErr()) {
        return Result.err(made.error);
      }
      await tx
        .update(invoices)
        .set({ workspaceId: null })
        .where(
          and(
            eq(invoices.id, made.value.id),
            eq(invoices.organizationId, session.activeOrganizationId),
            eq(invoices.clientId, params.clientId),
          ),
        );
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
        resourceId: made.value.id,
        workspaceId: null,
        changes: {
          workspaceId: { old: first.workspaceId, new: null },
        },
      });
      let entryCount = made.value.entryCount;
      let expenseCount = made.value.expenseCount;
      for (const matter of matters.slice(1)) {
        // db-await-in-loop: bounded matter groups share one transaction and invoice lock
        const attached = await appendClientInvoiceMatter(tx, {
          actorUserId: user.id,
          created: made.value,
          body: createInvoiceInput({
            ...invoiceDetails,
            timeEntryIds: matter.timeEntryIds,
            expenseIds: matter.expenseIds,
          }),
          workspaceId: matter.workspaceId,
          organizationId: session.activeOrganizationId,
          supplyDate,
          now,
          recordAuditEvent,
        });
        if (attached.isErr()) {
          return Result.err(attached.error);
        }
        entryCount += attached.value.entryCount;
        expenseCount += attached.value.expenseCount;
      }
      const totals = await recalculateInvoiceTotals(
        tx,
        { invoiceId: made.value.id, workspaceId: first.workspaceId },
        now,
        recordAuditEvent,
      );
      if (totals.isErr()) {
        return Result.err(totals.error);
      }
      if (
        expectedTotalAmount !== undefined &&
        totals.value.grossAmountMinor !== expectedTotalAmount
      ) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: "Invoice total changed; review the selected work again",
          }),
        );
      }
      return Result.ok({
        ...made.value,
        totalAmount: totals.value.grossAmountMinor,
        entryCount,
        expenseCount,
        workspaceId: first.workspaceId,
      });
    });
    return result.mapError(invoiceCreationError);
  },
  {
    authorize: async ({ scopedDb, session, params, body }) => {
      const selection = validateClientInvoiceSelection(body.matters);
      if (selection.isErr()) {
        return selection;
      }
      const authorization = await scopedDb(
        async (tx) =>
          await resolveClientInvoiceMatters(tx, {
            organizationId: session.activeOrganizationId,
            clientId: params.clientId,
            workspaceIds: selection.value.ids,
          }),
      );
      if (authorization.isErr()) {
        return authorization;
      }
      return Result.ok(undefined);
    },
  },
);
declareAggregateMutation(createClientInvoice, {
  type: "aggregate",
  aggregates: ["workspace"],
});

export default createClientInvoice;
