import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { billingCodes } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { PG_ERROR } from "@/api/lib/pg-error";

const createBillingCodeBodySchema = t.Object({
  type: t.UnionEnum(["task", "activity"]),
  code: t.String({ minLength: 1, maxLength: 20 }),
  label: t.String({ minLength: 1, maxLength: 256 }),
  active: t.Optional(t.Boolean()),
  sortOrder: t.Optional(t.Integer({ minimum: 0 })),
});

const config = {
  permissions: { billingCode: ["create"] },
  body: createBillingCodeBodySchema,
} satisfies HandlerConfig;

const createBillingCode = createSafeHandler(
  config,
  async function* ({ safeDb, session, workspaceId, body }) {
    const totalCodes = yield* Result.await(
      safeDb((tx) =>
        tx.$count(billingCodes, eq(billingCodes.workspaceId, workspaceId)),
      ),
    );

    if (totalCodes >= LIMITS.billingCodesPerWorkspace) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Billing codes limit reached for this workspace",
        }),
      );
    }

    const insertResult = await safeDb((tx) =>
      tx
        .insert(billingCodes)
        .values({
          organizationId: session.activeOrganizationId,
          workspaceId,
          type: body.type,
          code: body.code,
          label: body.label,
          active: body.active ?? true,
          sortOrder: body.sortOrder ?? 0,
        })
        .returning({ id: billingCodes.id }),
    );

    if (Result.isError(insertResult)) {
      if (
        DatabaseError.is(insertResult.error) &&
        insertResult.error.code === PG_ERROR.UNIQUE_VIOLATION
      ) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: "A billing code with this code already exists",
          }),
        );
      }
      return Result.err(insertResult.error);
    }

    const code = insertResult.value[0];
    if (!code) {
      panic("Failed to create billing code");
    }
    return Result.ok({ id: code.id });
  },
);

export default createBillingCode;
