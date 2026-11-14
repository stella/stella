import { and, eq, inArray, notExists, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { fields, properties } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type MarkPropertiesFreshParams = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  propertyIds: readonly SafeId<"property">[];
};

/**
 * Marks the given properties of a workspace fresh once a workflow run has
 * recomputed them. Property rows carry derived columns, so every write to
 * the table goes through this library; this one touches `status` only.
 */
export const markPropertiesFresh = async ({
  tx,
  workspaceId,
  propertyIds,
}: MarkPropertiesFreshParams): Promise<void> => {
  if (propertyIds.length === 0) {
    return;
  }
  await tx
    .update(properties)
    .set({ status: "fresh" })
    .where(
      and(
        eq(properties.workspaceId, workspaceId),
        inArray(properties.id, [...propertyIds]),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(fields)
            .where(
              and(
                eq(fields.workspaceId, workspaceId),
                eq(fields.propertyId, properties.id),
                sql`${fields.content}->>'type' = 'pending'`,
              ),
            ),
        ),
      ),
    );
};
