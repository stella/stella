import { eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { invoices } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export const readInvoicesQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
  offset: t.Optional(t.Integer({ minimum: 0 })),
});

type ReadInvoicesQuerySchema = Static<typeof readInvoicesQuerySchema>;

type ReadInvoicesHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  query: ReadInvoicesQuerySchema;
};

export const readInvoicesHandler = async ({
  scopedDb,
  workspaceId,
  query,
}: ReadInvoicesHandlerProps) => {
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
};
