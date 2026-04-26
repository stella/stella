import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { billingCodes } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";
import { pickDefined } from "@/api/lib/pick-defined";

const updateBillingCodeBodySchema = t.Object({
  id: tSafeId("billingCode"),
  code: t.Optional(t.String({ minLength: 1, maxLength: 20 })),
  label: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
  active: t.Optional(t.Boolean()),
  sortOrder: t.Optional(t.Integer({ minimum: 0 })),
});

const config = {
  permissions: { billingCode: ["update"] },
  body: updateBillingCodeBodySchema,
} satisfies HandlerConfig;

const updateBillingCode = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.billingCodes.findFirst({
          where: {
            id: { eq: body.id },
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

    const updates = pickDefined(body, ["code", "label", "active", "sortOrder"]);

    if (Object.keys(updates).length === 0) {
      return Result.ok({ id: body.id });
    }

    const updateResult = await safeDb((tx) =>
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

    if (Result.isError(updateResult)) {
      if (
        DatabaseError.is(updateResult.error) &&
        updateResult.error.code === PG_ERROR.UNIQUE_VIOLATION
      ) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: "A billing code with this code already exists",
          }),
        );
      }
      return Result.err(updateResult.error);
    }

    return Result.ok({ id: body.id });
  },
);

export default updateBillingCode;
