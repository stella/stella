import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { invoices } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";

const readInvoicesQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
  offset: t.Optional(t.Integer({ minimum: 0 })),
});

const readInvoices = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    query: readInvoicesQuerySchema,
  },
  async function* ({ safeDb, workspaceId, query }) {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const [rowsResult, totalResult] = await Promise.all([
      safeDb((tx) =>
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
      safeDb((tx) =>
        tx.$count(invoices, eq(invoices.workspaceId, workspaceId)),
      ),
    ]);

    const rows = yield* rowsResult;
    const total = yield* totalResult;

    return Result.ok({
      rows: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
    });
  },
);

export default readInvoices;
