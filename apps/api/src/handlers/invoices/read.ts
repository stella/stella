import { Result } from "better-result";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { t } from "elysia";

import { invoices } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedInvoiceId } from "@/api/lib/safe-id-boundaries";

const readInvoicesQuerySchema = t.Object({
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.invoicesPageSizeMax }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});

const invoiceCursor = createTimestampIdCursorCodec({
  column: invoices.createdAt,
  brandId: brandPersistedInvoiceId,
});

const readInvoices = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    mcp: { type: "tool", name: "list_invoices" },
    query: readInvoicesQuerySchema,
  },
  async function* ({ safeDb, workspaceId, query }) {
    const limit = query.limit ?? LIMITS.invoicesPageSizeDefault;
    const conditions = [eq(invoices.workspaceId, workspaceId)];

    if (query.cursor) {
      const cursor = invoiceCursor.decode(query.cursor);

      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }

      const boundary = invoiceCursor.boundary(cursor);
      const cursorCondition = or(
        gt(invoices.createdAt, boundary),
        and(eq(invoices.createdAt, boundary), gt(invoices.id, cursor.id)),
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
            createdAtCursor: invoiceCursor.cursorValue.as("created_at_cursor"),
            updatedAt: invoices.updatedAt,
          })
          .from(invoices)
          .where(and(...conditions))
          .orderBy(asc(invoices.createdAt), asc(invoices.id))
          .limit(limit + 1),
      ),
    );

    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        invoiceCursor.encode(item.createdAtCursor, item.id),
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
