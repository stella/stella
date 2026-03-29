import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { billingCodes } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

const deleteBillingCodeBodySchema = t.Object({
  id: tNanoid,
});

const config = {
  permissions: { billingCode: ["delete"] },
  body: deleteBillingCodeBodySchema,
} satisfies HandlerConfig;

const deleteBillingCode = createHandler(
  config,
  async ({ scopedDb, workspaceId, body }) => {
    const existing = await scopedDb((tx) =>
      tx.query.billingCodes.findFirst({
        where: {
          id: body.id,
          workspaceId: { eq: workspaceId },
        },
        columns: { id: true },
      }),
    );

    if (!existing) {
      return status(404, { message: "Billing code not found" });
    }

    await scopedDb((tx) =>
      tx
        .delete(billingCodes)
        .where(
          and(
            eq(billingCodes.id, body.id),
            eq(billingCodes.workspaceId, workspaceId),
          ),
        ),
    );

    return { deleted: true };
  },
);

export default deleteBillingCode;
