import { t, type Static } from "elysia";

import { db } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";

export const readInvoicesQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
  offset: t.Optional(t.Integer({ minimum: 0 })),
});

type ReadInvoicesQuerySchema = Static<typeof readInvoicesQuerySchema>;

type ReadInvoicesHandlerProps = {
  workspaceId: SafeId<"workspace">;
  query: ReadInvoicesQuerySchema;
};

export const readInvoicesHandler = async ({
  workspaceId,
  query,
}: ReadInvoicesHandlerProps) => {
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  const rows = await db.query.invoices.findMany({
    where: { workspaceId },
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
    orderBy: (invoices, { asc }) => asc(invoices.createdAt),
    limit,
    offset,
  });

  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
};
