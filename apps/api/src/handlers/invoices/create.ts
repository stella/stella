import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import { prorateHourlyCents } from "@stll/money";

import {
  BILLING_STATUS,
  INVOICE_STATUS,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import { PG_ERROR } from "@/api/lib/pg-error";

const createInvoiceBodySchema = t.Object({
  invoiceNumber: t.String({ minLength: 1, maxLength: 64 }),
  invoiceDate: t.String({ format: "date" }),
  dueDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  reference: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
  currency: t.String({ minLength: 3, maxLength: 3 }),
  notes: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
  timeEntryIds: t.Array(tSafeId("timeEntry"), {
    minItems: 1,
    maxItems: 500,
  }),
});

const createInvoice = createSafeHandler(
  {
    permissions: { invoice: ["create"] },
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
      safeDb((tx) =>
        tx
          .select({
            id: timeEntries.id,
            billedMinutes: timeEntries.billedMinutes,
            rateAtEntry: timeEntries.rateAtEntry,
            status: timeEntries.status,
            billable: timeEntries.billable,
            currency: timeEntries.currency,
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

    let totalAmount = 0;
    for (const entry of entries) {
      totalAmount += prorateHourlyCents({
        billedMinutes: entry.billedMinutes,
        hourlyRateCents: entry.rateAtEntry,
      });
    }

    const now = new Date();
    const expectedCount = entries.length;

    const txResult = await safeDb(async (tx) => {
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
          totalAmount: cents(totalAmount),
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
            // Re-check currency in the claiming update: if an entry's currency
            // changed between the preflight read and now, it is not claimed,
            // the count mismatch trips, and the caller retries.
            eq(timeEntries.currency, body.currency),
          ),
        )
        .returning({ id: timeEntries.id });

      const linkedCount = updated.length;
      if (linkedCount !== expectedCount) {
        return { ok: false as const };
      }

      await recordAuditEvent(tx, [
        {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
          resourceId: created.id,
          changes: {
            created: {
              old: null,
              new: {
                invoiceNumber: created.invoiceNumber,
                invoiceDate: body.invoiceDate,
                currency: body.currency,
                totalAmount,
                entryCount: linkedCount,
                status: INVOICE_STATUS.DRAFT,
              },
            },
          },
        },
        ...updated.map((entry) => ({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
          resourceId: entry.id,
          changes: {
            status: {
              old: BILLING_STATUS.APPROVED,
              new: BILLING_STATUS.BILLED,
            },
            invoiceId: { old: null, new: created.id },
          },
        })),
      ]);

      return {
        ok: true as const,
        id: created.id,
        invoiceNumber: created.invoiceNumber,
        totalAmount,
        entryCount: linkedCount,
      };
    });

    if (Result.isError(txResult)) {
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
    if (!result.ok) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Some entries were modified concurrently; please retry",
        }),
      );
    }

    return Result.ok({
      id: result.id,
      invoiceNumber: result.invoiceNumber,
      totalAmount: result.totalAmount,
      entryCount: result.entryCount,
    });
  },
);

export default createInvoice;
