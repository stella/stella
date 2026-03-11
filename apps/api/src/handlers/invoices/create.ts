import { and, eq, inArray } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import {
  BILLING_STATUS,
  INVOICE_STATUS,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { ConcurrentModificationError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

export const createInvoiceBodySchema = t.Object({
  invoiceNumber: t.String({ minLength: 1, maxLength: 64 }),
  invoiceDate: t.String({ format: "date" }),
  dueDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  reference: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
  currency: t.String({ minLength: 3, maxLength: 3 }),
  notes: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
  timeEntryIds: t.Array(tNanoid, {
    minItems: 1,
    maxItems: 500,
  }),
});

type CreateInvoiceBodySchema = Static<typeof createInvoiceBodySchema>;

type CreateInvoiceHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  body: CreateInvoiceBodySchema;
};

export const createInvoiceHandler = async ({
  scopedDb,
  organizationId,
  workspaceId,
  body,
}: CreateInvoiceHandlerProps) => {
  const totalInvoices = await scopedDb((tx) =>
    tx.$count(invoices, eq(invoices.workspaceId, workspaceId)),
  );

  if (totalInvoices >= LIMITS.invoicesPerWorkspace) {
    return status(400, {
      message: "Invoice limit reached for this workspace",
    });
  }

  // Pre-validate entries for user-facing error messages.
  const entries = await scopedDb((tx) =>
    tx
      .select({
        id: timeEntries.id,
        billedMinutes: timeEntries.billedMinutes,
        rateAtEntry: timeEntries.rateAtEntry,
        status: timeEntries.status,
        billable: timeEntries.billable,
      })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.workspaceId, workspaceId),
          inArray(timeEntries.id, body.timeEntryIds),
        ),
      ),
  );

  if (entries.length !== body.timeEntryIds.length) {
    return status(400, {
      message: "Some time entries were not found",
    });
  }

  const invalid = entries.some(
    (e) => e.status !== BILLING_STATUS.APPROVED || !e.billable,
  );
  if (invalid) {
    return status(400, {
      message: "All entries must be approved and billable",
    });
  }

  let totalAmount = 0;
  for (const entry of entries) {
    totalAmount += Math.round((entry.billedMinutes / 60) * entry.rateAtEntry);
  }

  const now = new Date();
  const expectedCount = entries.length;

  const result = await scopedDb(async (tx) => {
    const [created] = await tx
      .insert(invoices)
      .values({
        organizationId,
        workspaceId,
        invoiceNumber: body.invoiceNumber,
        invoiceDate: body.invoiceDate,
        dueDate: body.dueDate ?? null,
        reference: body.reference ?? null,
        currency: body.currency,
        totalAmount,
        notes: body.notes ?? null,
        status: INVOICE_STATUS.DRAFT,
      })
      .returning({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
      });

    // Re-verify status inside transaction to prevent races.
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
        ),
      );

    // If fewer entries matched, a concurrent request changed
    // them. Throwing rolls back the transaction automatically.
    const linkedCount = updated.rowCount ?? 0;
    if (linkedCount !== expectedCount) {
      throw new ConcurrentModificationError({
        message: "Time entries modified during invoice creation",
      });
    }

    return {
      id: created.id,
      invoiceNumber: created.invoiceNumber,
      totalAmount,
      entryCount: linkedCount,
    };
  }).catch((error: unknown) => {
    if (error instanceof ConcurrentModificationError) {
      return null;
    }
    throw error;
  });

  if (!result) {
    return status(409, {
      message: "Some entries were modified concurrently; please retry",
    });
  }

  return result;
};
