import { Result } from "better-result";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { t } from "elysia";

import { invoices } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
  parseDateTimePaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedInvoiceId } from "@/api/lib/safe-id-boundaries";

const readInvoicesQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});

type InvoiceCursor = {
  createdAt: Date;
  id: SafeId<"invoice">;
};

const invoiceCreatedAtCursor = sql<Date>`date_trunc('milliseconds', ${invoices.createdAt})`;

const decodeInvoiceCursor = (cursor: string): InvoiceCursor | null => {
  const parts = decodePaginationCursor(cursor);
  const createdAt = parts?.at(0);
  const id = parts?.at(1);

  const createdAtDate = parseDateTimePaginationCursorPart(createdAt);

  if (!createdAtDate || !isUuidPaginationCursorPart(id)) {
    return null;
  }

  return { createdAt: createdAtDate, id: brandPersistedInvoiceId(id) };
};

const readInvoices = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    query: readInvoicesQuerySchema,
  },
  async function* ({ safeDb, workspaceId, query }) {
    const limit = query.limit ?? 50;
    const conditions = [eq(invoices.workspaceId, workspaceId)];

    if (query.cursor) {
      const cursor = decodeInvoiceCursor(query.cursor);

      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }

      const cursorCondition = or(
        gt(invoiceCreatedAtCursor, cursor.createdAt),
        and(
          eq(invoiceCreatedAtCursor, cursor.createdAt),
          gt(invoices.id, cursor.id),
        ),
      );

      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            reference: invoices.reference,
            status: invoices.status,
            invoiceDate: invoices.invoiceDate,
            dueDate: invoices.dueDate,
            currency: invoices.currency,
            totalAmount: invoices.totalAmount,
            createdAt: invoices.createdAt,
            createdAtCursor: invoiceCreatedAtCursor.as("created_at_cursor"),
            updatedAt: invoices.updatedAt,
          })
          .from(invoices)
          .where(and(...conditions))
          .orderBy(asc(invoiceCreatedAtCursor), asc(invoices.id))
          .limit(limit + 1),
      ),
    );

    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        encodePaginationCursor([item.createdAtCursor.toISOString(), item.id]),
    });

    return Result.ok({
      ...page,
      items: page.items.map((row) => ({
        id: row.id,
        invoiceNumber: row.invoiceNumber,
        reference: row.reference,
        status: row.status,
        invoiceDate: row.invoiceDate,
        dueDate: row.dueDate,
        currency: row.currency,
        totalAmount: row.totalAmount,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    });
  },
);

export default readInvoices;
