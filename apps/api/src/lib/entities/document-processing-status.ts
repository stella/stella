import { and, desc, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  documentProcessingRuns,
  type DocumentProcessingStatus,
  entities,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export const getCurrentVersionProcessingStatuses = async (
  tx: Transaction,
  entityIds: readonly SafeId<"entity">[],
): Promise<Map<string, DocumentProcessingStatus>> => {
  if (entityIds.length === 0) {
    return new Map();
  }

  const rows = await tx
    .selectDistinctOn([documentProcessingRuns.entityId], {
      entityId: documentProcessingRuns.entityId,
      status: documentProcessingRuns.status,
    })
    .from(documentProcessingRuns)
    .innerJoin(
      entities,
      and(
        eq(entities.id, documentProcessingRuns.entityId),
        eq(entities.workspaceId, documentProcessingRuns.workspaceId),
        eq(entities.currentVersionId, documentProcessingRuns.entityVersionId),
      ),
    )
    .where(inArray(documentProcessingRuns.entityId, entityIds))
    .orderBy(
      documentProcessingRuns.entityId,
      desc(documentProcessingRuns.createdAt),
      desc(documentProcessingRuns.id),
    )
    .limit(entityIds.length);

  return new Map(rows.map((row) => [row.entityId, row.status]));
};
