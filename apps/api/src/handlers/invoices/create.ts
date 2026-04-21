import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import {
  BILLING_STATUS,
  INVOICE_STATUS,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tUuid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const createInvoiceBodySchema = t.Object({
  invoiceNumber: t.String({ minLength: 1, maxLength: 64 }),
  invoiceDate: t.String({ format: "date" }),
  dueDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  reference: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
  currency: t.String({ minLength: 3, maxLength: 3 }),
  notes: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
  timeEntryIds: t.Array(tUuid, {
    minItems: 1,
    maxItems: 500,
  }),
});

const createInvoice = createSafeHandler(
  {
    permissions: { invoice: ["create"] },
    body: createInvoiceBodySchema,
  },
  async function* ({ safeDb, session, workspaceId, body }) {
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
      safeDb((tx) =>
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
      ),
    );

    if (entries.length !== body.timeEntryIds.length) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Some time entries were not found",
        }),
      );
    }

    const invalid = entries.some(
      (e) => e.status !== BILLING_STATUS.APPROVED || !e.billable,
    );
    if (invalid) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "All entries must be approved and billable",
        }),
      );
    }

    let totalAmount = 0;
    for (const entry of entries) {
      totalAmount += Math.round((entry.billedMinutes / 60) * entry.rateAtEntry);
    }

    const now = new Date();
    const expectedCount = entries.length;

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const [created] = await tx
          .insert(invoices)
          .values({
            organizationId: session.activeOrganizationId,
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

        if (!created) {
          return { ok: false as const };
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
            ),
          )
          .returning({ id: timeEntries.id });

        const linkedCount = updated.length;
        if (linkedCount !== expectedCount) {
          return { ok: false as const };
        }

        return {
          ok: true as const,
          id: created.id,
          invoiceNumber: created.invoiceNumber,
          totalAmount,
          entryCount: linkedCount,
        };
      }),
    );

    if (!txResult.ok) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Some entries were modified concurrently; please retry",
        }),
      );
    }

    return Result.ok({
      id: txResult.id,
      invoiceNumber: txResult.invoiceNumber,
      totalAmount: txResult.totalAmount,
      entryCount: txResult.entryCount,
    });
  },
);

export default createInvoice;
