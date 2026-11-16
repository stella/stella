import { Result } from "better-result";
import { and, asc } from "drizzle-orm";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";
import { withBillingRead } from "@stll/permissions";

import { invoices } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import {
  invoicePaidAmountSql,
  invoicePaymentAmounts,
} from "@/api/lib/billing/invoice-payments";
import {
  invoiceMatterShare,
  invoiceTouchesMatter,
} from "@/api/lib/billing/invoice-scope";
import { invoiceListMoneyResponse } from "@/api/lib/billing/response-schemas";
import { paginationCursorSchema } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedInvoiceId } from "@/api/lib/safe-id-boundaries";

const readInvoicesQuerySchema = v.object({
  limit: v.optional(
    v.pipe(
      numberFromString(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(LIMITS.invoicesPageSizeMax),
        ),
      ),
      v.description("Max invoices to return"),
    ),
  ),
  cursor: v.optional(
    paginationCursorSchema({
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
    moneyResponse: invoiceListMoneyResponse,
    contract: "patch",
    description:
      "List a matter's invoices oldest first with cursor pagination, " +
      "returning each invoice's number (null before numbering), document type, original invoice id, reference, status, dates, currency, language, " +
      "total, and paid and outstanding amounts, but not its line items. Use invoices.get to read the " +
      "attached time entries and expenses.",
    permissions: withBillingRead({ workspace: ["read"] }),
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: { type: "tool", name: "list_invoices" },
    access: "read",
    query: readInvoicesQuerySchema,
  },
  async function* ({ safeDb, workspaceId, query }) {
    const limit = normalizeTenantPageLimit(
      query.limit ?? LIMITS.invoicesPageSizeDefault,
    );
    const conditions = [invoiceTouchesMatter(invoices, workspaceId)];

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
            clientId: invoices.clientId,
            matterShare: invoiceMatterShare(invoices, workspaceId),
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            documentType: invoices.documentType,
            originalInvoiceId: invoices.originalInvoiceId,
            reference: invoices.reference,
            status: invoices.status,
            invoiceDate: invoices.invoiceDate,
            dueDate: invoices.dueDate,
            currency: invoices.currency,
            language: invoices.language,
            totalAmount: invoices.totalAmount,
            paidAmount: invoicePaidAmountSql(invoices),
            billingMode: invoices.billingMode,
            flatFeeAmount: invoices.flatFeeAmount,
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
        clientId: row.clientId,
        matterShare: row.matterShare,
        id: row.id,
        invoiceNumber: row.invoiceNumber,
        documentType: row.documentType,
        originalInvoiceId: row.originalInvoiceId,
        reference: row.reference,
        status: row.status,
        invoiceDate: row.invoiceDate,
        dueDate: row.dueDate,
        currency: row.currency,
        language: row.language,
        totalAmount: row.totalAmount,
        ...invoicePaymentAmounts(row),
        billingMode: row.billingMode,
        flatFeeAmount: row.flatFeeAmount,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    });
  },
);

export default readInvoices;
