import { panic, Result } from "better-result";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { type Static, t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { resultTx } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  INVOICE_STATUS,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import {
  ATTACHED_ENTRY_LINE_VAT,
  insertInvoiceLines,
  recalculateInvoiceTotals,
  timeEntryLineDraft,
} from "@/api/handlers/invoices/invoice-lines";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tCurrencyCode, tSafeId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import type { CentsAmount } from "@/api/lib/money";
import { PG_ERROR } from "@/api/lib/pg-error";

import {
  INVOICE_ENTRIES_MODIFIED_MESSAGE,
  isInvoiceEntriesModifiedConcurrentlyError,
} from "./concurrent-modification";
import { tInvoiceDocumentType, validateInvoiceDocument } from "./document-type";

const createInvoiceBodySchema = t.Object({
  invoiceNumber: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  documentType: t.Optional(tInvoiceDocumentType),
  originalInvoiceId: t.Optional(tSafeId("invoice")),
  invoiceDate: t.String({ format: "date" }),
  dueDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  reference: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
  currency: tCurrencyCode,
  notes: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
  timeEntryIds: t.Array(tSafeId("timeEntry"), {
    minItems: 0,
    maxItems: 500,
  }),
});

/** Each attached entry moves from approved to billed on this invoice. */
const billedEntryEvents = (
  entries: readonly { id: SafeId<"timeEntry"> }[],
  invoiceId: SafeId<"invoice">,
) =>
  entries.map((entry) => ({
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
    resourceId: entry.id,
    changes: {
      status: { old: BILLING_STATUS.APPROVED, new: BILLING_STATUS.BILLED },
      invoiceId: { old: null, new: invoiceId },
    },
  }));

type CreateInvoiceResult = {
  id: SafeId<"invoice">;
  invoiceNumber: string | null;
  totalAmount: CentsAmount;
  entryCount: number;
};
type CreateInvoiceBody = Static<typeof createInvoiceBodySchema>;
const validateEntries = async (
  safeDb: SafeDb,
  workspaceId: SafeId<"workspace">,
  body: CreateInvoiceBody,
) => {
  const entriesResult = await safeDb((tx) =>
    tx
      .select({
        id: timeEntries.id,
        status: timeEntries.status,
        billable: timeEntries.billable,
        currency: timeEntries.currency,
        invoiceId: timeEntries.invoiceId,
      })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.workspaceId, workspaceId),
          inArray(timeEntries.id, body.timeEntryIds),
        ),
      ),
  );
  if (entriesResult.isErr()) {
    return Result.err(entriesResult.error);
  }
  const entries = entriesResult.value;

  if (entries.length !== body.timeEntryIds.length) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Some time entries were not found",
      }),
    );
  }

  const invalid = entries.some(
    (e) =>
      e.status !== BILLING_STATUS.APPROVED ||
      !e.billable ||
      e.invoiceId !== null,
  );
  if (invalid) {
    return Result.err(
      new HandlerError({
        status: 400,
        message:
          "All entries must be approved, billable," +
          " and not already on an invoice",
      }),
    );
  }

  // An invoice is single-currency: there is no FX conversion, so summing
  // entries in different currencies would produce a meaningless total.
  const currencyMismatch = entries.some((e) => e.currency !== body.currency);
  if (currencyMismatch) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "All time entries must match the invoice currency",
      }),
    );
  }

  return Result.ok(entries);
};

const createInvoice = createSafeHandler(
  {
    description:
      "Create a draft invoice from approved, billable, not-yet-invoiced time " +
      "entries in a matter, marking them billed and setting the total from " +
      "their billed minutes and recorded rates. Every entry must already " +
      "carry the invoice currency, since nothing is converted, and the " +
      "optional invoice number must not already be in use. An omitted number " +
      "is allocated from the document type’s default series at finalize. Credit " +
      "notes require an original finalized, sent, or paid invoice in the same matter. " +
      "Pass empty timeEntryIds for a draft with manual lines. Expenses are added " +
      "afterwards with invoices.entries.add.",
    permissions: { invoice: ["create"] },
    mcp: { type: "capability", reason: "billing_admin" },
    body: createInvoiceBodySchema,
  },
  async function* ({ safeDb, session, workspaceId, body, recordAuditEvent }) {
    const totalInvoices = yield* Result.await(
      safeDb((tx) =>
        tx.$count(invoices, eq(invoices.workspaceId, workspaceId)),
      ),
    );

    if (totalInvoices >= LIMITS.invoicesPerWorkspace) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invoice limit reached for this workspace",
        }),
      );
    }

    const entries = yield* Result.await(
      validateEntries(safeDb, workspaceId, body),
    );

    const now = new Date();
    const expectedCount = entries.length;

    const txResult = await resultTx(
      safeDb,
      async (tx): Promise<Result<CreateInvoiceResult, HandlerError>> => {
        const documentType = body.documentType ?? "invoice";
        const originalInvoiceId = body.originalInvoiceId ?? null;
        const valid = await validateInvoiceDocument(tx, {
          workspaceId,
          documentType,
          originalInvoiceId,
          currency: body.currency,
        });
        if (valid.isErr()) {
          return Result.err(valid.error);
        }
        const [created] = await tx
          .insert(invoices)
          .values({
            organizationId: session.activeOrganizationId,
            workspaceId,
            invoiceNumber: body.invoiceNumber ?? null,
            documentType,
            originalInvoiceId,
            invoiceDate: body.invoiceDate,
            dueDate: body.dueDate ?? null,
            reference: body.reference ?? null,
            currency: body.currency,
            notes: body.notes ?? null,
            status: INVOICE_STATUS.DRAFT,
          })
          .returning({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
          });

        if (!created) {
          return panic("Invoice insert returned no row");
        }

        const updated = await tx
          .update(timeEntries)
          .set({
            invoiceId: created.id,
            status: BILLING_STATUS.BILLED,
            updatedAt: now,
          })
          .where(
            and(
              eq(timeEntries.workspaceId, workspaceId),
              inArray(timeEntries.id, body.timeEntryIds),
              eq(timeEntries.status, BILLING_STATUS.APPROVED),
              eq(timeEntries.billable, true),
              isNull(timeEntries.invoiceId),
              // Re-check currency in the claiming update: if an entry's currency
              // changed between the preflight read and now, it is not claimed,
              // the count mismatch trips, and the caller retries.
              eq(timeEntries.currency, body.currency),
            ),
          )
          .returning({
            id: timeEntries.id,
            billedMinutes: timeEntries.billedMinutes,
            rateAtEntry: timeEntries.rateAtEntry,
            narrative: timeEntries.narrative,
            invoiceNarrative: timeEntries.invoiceNarrative,
          });

        const linkedCount = updated.length;
        if (linkedCount !== expectedCount) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: INVOICE_ENTRIES_MODIFIED_MESSAGE,
            }),
          );
        }

        // The lines and totals written below record their own invoice events.
        await recordAuditEvent(tx, [
          {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
            resourceId: created.id,
            metadata: { documentType, originalInvoiceId },
            changes: {
              created: {
                old: null,
                new: {
                  invoiceNumber: created.invoiceNumber,
                  invoiceDate: body.invoiceDate,
                  currency: body.currency,
                  entryCount: linkedCount,
                  status: INVOICE_STATUS.DRAFT,
                },
              },
            },
          },
          ...billedEntryEvents(updated, created.id),
        ]);

        const scope = { invoiceId: created.id, workspaceId };
        await insertInvoiceLines(
          tx,
          { ...scope, organizationId: session.activeOrganizationId },
          updated.map((entry) =>
            timeEntryLineDraft(entry, ATTACHED_ENTRY_LINE_VAT),
          ),
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

        return Result.ok({
          id: created.id,
          invoiceNumber: created.invoiceNumber,
          totalAmount,
          entryCount: linkedCount,
        });
      },
    );

    if (Result.isError(txResult)) {
      if (isInvoiceEntriesModifiedConcurrentlyError(txResult.error)) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: INVOICE_ENTRIES_MODIFIED_MESSAGE,
          }),
        );
      }
      if (
        DatabaseError.is(txResult.error) &&
        txResult.error.code === PG_ERROR.UNIQUE_VIOLATION
      ) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: "An invoice with this number already exists",
          }),
        );
      }
      return Result.err(txResult.error);
    }

    const result = txResult.value;

    return Result.ok({
      id: result.id,
      invoiceNumber: result.invoiceNumber,
      totalAmount: result.totalAmount,
      entryCount: result.entryCount,
    });
  },
);

export default createInvoice;
