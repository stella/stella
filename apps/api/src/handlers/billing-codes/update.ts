import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { billingCodes } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import { pickDefined } from "@/api/lib/pick-defined";

export const updateBillingCodeBodySchema = t.Object({
  id: tNanoid,
  code: t.Optional(t.String({ minLength: 1, maxLength: 20 })),
  label: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
  active: t.Optional(t.Boolean()),
  sortOrder: t.Optional(t.Integer({ minimum: 0 })),
});

type UpdateBillingCodeBodySchema = Static<typeof updateBillingCodeBodySchema>;

type UpdateBillingCodeHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  body: UpdateBillingCodeBodySchema;
};

export const updateBillingCodeHandler = async ({
  scopedDb,
  workspaceId,
  body,
}: UpdateBillingCodeHandlerProps) => {
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
};
