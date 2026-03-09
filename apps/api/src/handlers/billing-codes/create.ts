import { eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { billingCodes } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

export const createBillingCodeBodySchema = t.Object({
  type: t.UnionEnum(["task", "activity"]),
  code: t.String({ minLength: 1, maxLength: 20 }),
  label: t.String({ minLength: 1, maxLength: 256 }),
  active: t.Optional(t.Boolean()),
  sortOrder: t.Optional(t.Integer({ minimum: 0 })),
});

type CreateBillingCodeBodySchema = Static<typeof createBillingCodeBodySchema>;

type CreateBillingCodeHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  body: CreateBillingCodeBodySchema;
};

export const createBillingCodeHandler = async ({
  scopedDb,
  organizationId,
  workspaceId,
  body,
}: CreateBillingCodeHandlerProps) => {
  const totalCodes = await scopedDb((tx) =>
    tx.$count(billingCodes, eq(billingCodes.workspaceId, workspaceId)),
  );

  if (totalCodes >= LIMITS.billingCodesPerWorkspace) {
    return status(400, {
      message: "Billing codes limit reached for this workspace",
    });
  }

  try {
    const [code] = await scopedDb((tx) =>
      tx
        .insert(billingCodes)
        .values({
          organizationId,
          workspaceId,
          type: body.type,
          code: body.code,
          label: body.label,
          active: body.active ?? true,
          sortOrder: body.sortOrder ?? 0,
        })
        .returning({ id: billingCodes.id }),
    );

    return { id: code.id };
  } catch (error) {
    if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) {
      return status(409, {
        message: "A billing code with this code already exists",
      });
    }
    throw error;
  }
};
