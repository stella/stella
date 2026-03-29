import { and, asc, eq } from "drizzle-orm";
import { t } from "elysia";

import { billingCodes } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const readBillingCodesQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 1000 })),
  offset: t.Optional(t.Integer({ minimum: 0 })),
  type: t.Optional(t.Union([t.Literal("task"), t.Literal("activity")])),
  active: t.Optional(t.BooleanString()),
});

const config = {
  permissions: { workspace: ["read"] },
  query: readBillingCodesQuerySchema,
} satisfies HandlerConfig;

const readBillingCodes = createHandler(
  config,
  async ({ scopedDb, workspaceId, query }) => {
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
  },
);

export default readBillingCodes;
