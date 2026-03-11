import { and, asc, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { billingCodes } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export const readBillingCodesQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 1000 })),
  offset: t.Optional(t.Integer({ minimum: 0 })),
  type: t.Optional(t.Union([t.Literal("task"), t.Literal("activity")])),
  active: t.Optional(t.BooleanString()),
});

type ReadBillingCodesQuerySchema = Static<typeof readBillingCodesQuerySchema>;

type ReadBillingCodesHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  query: ReadBillingCodesQuerySchema;
};

export const readBillingCodesHandler = async ({
  scopedDb,
  workspaceId,
  query,
}: ReadBillingCodesHandlerProps) => {
  const limit = query.limit ?? 500;
  const offset = query.offset ?? 0;

  const conditions = [eq(billingCodes.workspaceId, workspaceId)];

  if (query.type) {
    conditions.push(eq(billingCodes.type, query.type));
  }
  if (query.active !== undefined) {
    conditions.push(eq(billingCodes.active, query.active));
  }

  return await scopedDb((tx) =>
    tx
      .select({
        id: billingCodes.id,
        type: billingCodes.type,
        code: billingCodes.code,
        label: billingCodes.label,
        active: billingCodes.active,
        sortOrder: billingCodes.sortOrder,
      })
      .from(billingCodes)
      .where(and(...conditions))
      .orderBy(asc(billingCodes.sortOrder), asc(billingCodes.code))
      .limit(limit)
      .offset(offset),
  );
};
