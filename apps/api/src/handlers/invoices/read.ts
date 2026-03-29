import { eq } from "drizzle-orm";
import { t } from "elysia";

import { invoices } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";

export const readInvoicesQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
  offset: t.Optional(t.Integer({ minimum: 0 })),
});

const readInvoices = createHandler(
  {
    permissions: { workspace: ["read"] },
    query: readInvoicesQuerySchema,
  },
  async ({ scopedDb, workspaceId, query }) => {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const [rows, total] = await Promise.all([
      scopedDb((tx) =>
        tx.query.invoices.findMany({
          where: { workspaceId: { eq: workspaceId } },
          columns: {
            id: true,
            invoiceNumber: true,
            reference: true,
            status: true,
            invoiceDate: true,
            dueDate: true,
            currency: true,
            totalAmount: true,
            createdAt: true,
          },
          orderBy: (inv, { asc }) => asc(inv.createdAt),
          limit,
          offset,
        }),
      ),
      scopedDb((tx) =>
        tx.$count(invoices, eq(invoices.workspaceId, workspaceId)),
      ),
    ]);

    return {
      rows: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
    };
  },
);

export default readInvoices;
