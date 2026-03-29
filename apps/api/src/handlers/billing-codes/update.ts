import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { billingCodes } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import { pickDefined } from "@/api/lib/pick-defined";

const updateBillingCodeBodySchema = t.Object({
  id: tNanoid,
  code: t.Optional(t.String({ minLength: 1, maxLength: 20 })),
  label: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
  active: t.Optional(t.Boolean()),
  sortOrder: t.Optional(t.Integer({ minimum: 0 })),
});

const config = {
  permissions: { billingCode: ["update"] },
  body: updateBillingCodeBodySchema,
} satisfies HandlerConfig;

const updateBillingCode = createHandler(
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

    const updates = pickDefined(body, ["code", "label", "active", "sortOrder"]);

    if (Object.keys(updates).length === 0) {
      return { id: body.id };
    }

    try {
      await scopedDb((tx) =>
        tx
          .update(billingCodes)
          .set(updates)
          .where(
            and(
              eq(billingCodes.id, body.id),
              eq(billingCodes.workspaceId, workspaceId),
            ),
          ),
      );

      return { id: body.id };
    } catch (error) {
      if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) {
        return status(409, {
          message: "A billing code with this code already exists",
        });
      }
      throw error;
    }
  },
);

export default updateBillingCode;
