import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { billingCodes } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

export const updateBillingCodeBodySchema = t.Object({
  id: tNanoid,
  code: t.Optional(t.String({ minLength: 1, maxLength: 20 })),
  label: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
  active: t.Optional(t.Boolean()),
  sortOrder: t.Optional(t.Integer({ minimum: 0 })),
});

type UpdateBillingCodeBodySchema = Static<typeof updateBillingCodeBodySchema>;

type UpdateBillingCodeHandlerProps = {
  workspaceId: SafeId<"workspace">;
  body: UpdateBillingCodeBodySchema;
};

export const updateBillingCodeHandler = async ({
  workspaceId,
  body,
}: UpdateBillingCodeHandlerProps) => {
  const existing = await db.query.billingCodes.findFirst({
    where: {
      id: body.id,
      workspaceId,
    },
    columns: { id: true },
  });

  if (!existing) {
    return status(404, { message: "Billing code not found" });
  }

  const updates: Record<string, unknown> = {};

  if (body.code !== undefined) {
    updates.code = body.code;
  }
  if (body.label !== undefined) {
    updates.label = body.label;
  }
  if (body.active !== undefined) {
    updates.active = body.active;
  }
  if (body.sortOrder !== undefined) {
    updates.sortOrder = body.sortOrder;
  }

  if (Object.keys(updates).length === 0) {
    return { id: body.id };
  }

  try {
    await db
      .update(billingCodes)
      .set(updates)
      .where(
        and(
          eq(billingCodes.id, body.id),
          eq(billingCodes.workspaceId, workspaceId),
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
};
