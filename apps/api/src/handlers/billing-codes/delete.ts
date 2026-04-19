import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { billingCodes } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteBillingCodeBodySchema = t.Object({
  id: tNanoid,
});

const config = {
  permissions: { billingCode: ["delete"] },
  body: deleteBillingCodeBodySchema,
} satisfies HandlerConfig;

const deleteBillingCode = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.billingCodes.findFirst({
          where: {
            id: body.id,
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Billing code not found" }),
      );
    }

    yield* Result.await(
      safeDb((tx) =>
        tx
          .delete(billingCodes)
          .where(
            and(
              eq(billingCodes.id, body.id),
              eq(billingCodes.workspaceId, workspaceId),
            ),
          ),
      ),
    );

    return Result.ok({ deleted: true });
  },
);

export default deleteBillingCode;
