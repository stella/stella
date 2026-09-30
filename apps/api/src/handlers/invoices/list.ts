import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import { t } from "elysia";

import { invoices } from "@/api/db/schema";
import type { INVOICE_SUMMARY_OMITTED_COLUMNS } from "@/api/handlers/invoices/invoice-detail";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import type {
  UnprojectedColumns,
  UnbackedProjectionKeys,
} from "@/api/lib/projection-totality";
import { brandPersistedInvoiceId } from "@/api/lib/safe-id-boundaries";

const readInvoicesQuerySchema = t.Object({
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.invoicesPageSizeMax,
      description: "Max invoices to return",
    }),
  ),
  cursor: t.Optional(
    tPaginationCursor({
      description:
        "Opaque cursor from a previous list_invoices call to fetch the next page",
    }),
  ),
});

const invoiceCursor = createTimestampIdCursorCodec({
  column: invoices.createdAt,
  brandId: brandPersistedInvoiceId,
});

const readInvoices = createSafeHandler(
  {
    description:
      "List a matter's invoices oldest first with cursor pagination, " +
      "returning each invoice's number (null before numbering), document type, original invoice id, reference, status, dates, currency, " +
      "and total, but not its line items. Use invoices.get to read the " +
      "attached time entries and expenses.",
    permissions: { workspace: ["read"] },
    mcp: { type: "tool", name: "list_invoices" },
    access: "read",
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

      const cursorCondition = invoiceCursor.keysetAfter({
        cursor,
        idColumn: invoices.id,
        direction: "ascending",
      });

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
            documentType: invoices.documentType,
            originalInvoiceId: invoices.originalInvoiceId,
            reference: invoices.reference,
            status: invoices.status,
            invoiceDate: invoices.invoiceDate,
            dueDate: invoices.dueDate,
            currency: invoices.currency,
            totalAmount: invoices.totalAmount,
            paidAt: invoices.paidAt,
            paidDate: invoices.paidDate,
            paidAmount: invoices.paidAmount,
            paymentNote: invoices.paymentNote,
            paymentReference: invoices.paymentReference,
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

    type SummaryRow = Omit<(typeof rows)[number], "createdAtCursor">;
    type MissingSummaryColumn = UnprojectedColumns<
      typeof invoices.$inferSelect,
      SummaryRow,
      (typeof INVOICE_SUMMARY_OMITTED_COLUMNS)[number]
    >;
    type ExtraSummaryColumn = UnbackedProjectionKeys<
      typeof invoices.$inferSelect,
      SummaryRow,
      (typeof INVOICE_SUMMARY_OMITTED_COLUMNS)[number]
    >;
    true satisfies MissingSummaryColumn extends never ? true : never;
    true satisfies ExtraSummaryColumn extends never ? true : never;

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
        documentType: row.documentType,
        originalInvoiceId: row.originalInvoiceId,
        reference: row.reference,
        status: row.status,
        invoiceDate: row.invoiceDate,
        dueDate: row.dueDate,
        currency: row.currency,
        totalAmount: row.totalAmount,
        paidAt: row.paidAt?.toISOString() ?? null,
        paidDate: row.paidDate,
        paidAmount: row.paidAmount,
        paymentNote: row.paymentNote,
        paymentReference: row.paymentReference,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    });
  },
);

export default readInvoices;
