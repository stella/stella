import { and, asc, eq, gt } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { entities, searchDocuments } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { upsertSearchDocument } from "@/api/lib/search/index-entity";
import type {
  RemoveEntityOptions,
  SearchMaintenance,
} from "@/api/lib/search/types";
import { syncWorkspaceSearchActivity } from "@/api/lib/search/workspace-search-activity";

const REINDEX_BATCH_SIZE = 100;

const indexEntity = async (entityId: SafeId<"entity">): Promise<void> => {
  await upsertSearchDocument(entityId);
};

const removeEntity = async ({
  entityId,
  workspaceId,
}: RemoveEntityOptions): Promise<void> => {
  // audit: skip - removes a derived search projection after its source entity deletion.
  await rootDb
    .delete(searchDocuments)
    .where(eq(searchDocuments.entityId, entityId));

  await syncWorkspaceSearchActivity(workspaceId);
};

// Upsert all entities without deleting first to avoid search
// blackout. CASCADE FK handles deleted entities' search docs.
const rebuildIndex = async (orgId: SafeId<"organization">): Promise<void> => {
  const orgWorkspaces = await rootDb.query.workspaces.findMany({
    where: { organizationId: { eq: orgId } },
    columns: { id: true },
    limit: LIMITS.workspacesCount,
  });

  for (const ws of orgWorkspaces) {
    const wsId = toSafeId<"workspace">(ws.id);
    let lastId: SafeId<"entity"> | null = null;
    let hasMore = true;
    while (hasMore) {
      // Keyset pagination: O(1) per batch vs O(N) for offset
      // db-await-in-loop: keyset page per iteration; the page is the batch
      const batch = await rootDb
        .select({ id: entities.id })
        .from(entities)
        .where(
          lastId !== null
            ? and(eq(entities.workspaceId, wsId), gt(entities.id, lastId))
            : eq(entities.workspaceId, wsId),
        )
        .orderBy(asc(entities.id))
        .limit(REINDEX_BATCH_SIZE);

      for (const entity of batch) {
        // db-await-in-loop: full rebuild: each entity's document is built from its own fields and text, and no batched builder exists; the keyset page bounds each pass
        await indexEntity(entity.id);
      }

      hasMore = batch.length === REINDEX_BATCH_SIZE;
      const last = batch.at(-1);
      if (last) {
        lastId = last.id;
      }
    }
  }
};

const pgFtsSearchMaintenance: SearchMaintenance = {
  indexEntity,
  removeEntity,
  rebuildIndex,
};

export const getSearchMaintenance = (): SearchMaintenance =>
  pgFtsSearchMaintenance;
