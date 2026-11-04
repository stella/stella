import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { entities, fields } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type StaleCellTargets = {
  entityIds: SafeId<"entity">[];
  propertyIds: SafeId<"property">[];
};

/**
 * The documents and columns of a matter holding a stale outcome on their
 * current version: a run settled them before their inputs changed.
 *
 * A run takes a document list and a column list, so it covers their product.
 * A new version marks every column reading the file, so documents supplemented
 * together are stale in the same columns and the product is the stale set; a
 * document stale in fewer columns than another also re-runs the others.
 */
export const readStaleCellTargets = async ({
  tx,
  workspaceId,
}: {
  tx: Pick<Transaction, "selectDistinct">;
  workspaceId: SafeId<"workspace">;
}): Promise<StaleCellTargets> => {
  const rows = await tx
    .selectDistinct({
      entityId: entities.id,
      propertyId: fields.propertyId,
    })
    .from(fields)
    .innerJoin(
      entities,
      and(
        eq(entities.currentVersionId, fields.entityVersionId),
        eq(entities.workspaceId, fields.workspaceId),
      ),
    )
    .where(
      and(
        eq(fields.workspaceId, workspaceId),
        sql`${fields.aiSettlement} ? 'stale'`,
      ),
    );
  return {
    entityIds: [...new Set(rows.map(({ entityId }) => entityId))],
    propertyIds: [...new Set(rows.map(({ propertyId }) => propertyId))],
  };
};
