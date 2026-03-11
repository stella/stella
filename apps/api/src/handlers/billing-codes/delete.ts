import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { billingCodes } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";

export const deleteBillingCodeBodySchema = t.Object({
  id: tNanoid,
});

type DeleteBillingCodeBodySchema = Static<typeof deleteBillingCodeBodySchema>;

type DeleteBillingCodeHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  body: DeleteBillingCodeBodySchema;
};

export const deleteBillingCodeHandler = async ({
  scopedDb,
  workspaceId,
  body,
}: DeleteBillingCodeHandlerProps) => {
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
};
