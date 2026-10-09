import { and, asc, eq, gt } from "drizzle-orm";

import type { ScopedTransaction } from "@/api/db/safe-db";
import { entities, searchDocuments } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import { writeSearchBookkeeping } from "@/api/lib/db/recovery-bookkeeping/search";
import { LIMITS } from "@/api/lib/limits";
import { iterateCursorPages } from "@/api/lib/pagination";
import type {
  RemoveEntityOptions,
  SearchMaintenance,
} from "@/api/lib/search/types";
import { syncWorkspaceSearchActivity } from "@/api/lib/search/workspace-search-activity";

const REINDEX_BATCH_SIZE = 100;

type SearchMaintenanceDatabase = Pick<
  ScopedTransaction,
  "select" | "query" | "delete" | "execute"
>;

export const getSearchMaintenance = (
  database: SearchMaintenanceDatabase,
  indexEntity: SearchMaintenance["indexEntity"],
): SearchMaintenance => {
  const removeEntity = async ({
    entityId,
    workspaceId,
  }: RemoveEntityOptions): Promise<void> => {
    await writeSearchBookkeeping({
      type: "remove-entity",
      db: database,
      table: searchDocuments,
      entityId,
    });

    await syncWorkspaceSearchActivity(workspaceId, database);
  };

  // Upsert all entities without deleting first to avoid search
  // blackout. CASCADE FK handles deleted entities' search docs.
  const rebuildIndex = async (orgId: SafeId<"organization">): Promise<void> => {
    const orgWorkspaces = await database.query.workspaces.findMany({
      where: { organizationId: { eq: orgId } },
      columns: { id: true },
      limit: LIMITS.workspacesCount,
    });

    for (const ws of orgWorkspaces) {
      const wsId = toSafeId<"workspace">(ws.id);
      const readPage = (cursor: string | null) =>
        readCursorPage(
          // Keyset pagination: O(1) per batch vs O(N) for offset
          // db-await-in-loop: keyset page per iteration; the page is the batch
          database
            .select({ id: entities.id })
            .from(entities)
            .where(
              cursor !== null
                ? and(eq(entities.workspaceId, wsId), gt(entities.id, cursor))
                : eq(entities.workspaceId, wsId),
            )
            .orderBy(asc(entities.id)),
          { limit: REINDEX_BATCH_SIZE, cursorForItem: (entity) => entity.id },
        );
      for await (const batch of iterateCursorPages(readPage)) {
        for (const entity of batch) {
          // db-await-in-loop: full rebuild: each entity's document is built from its own fields and text, and no batched builder exists; the keyset page bounds each pass
          await indexEntity(entity.id);
        }
      }
    }
  };

  return {
    indexEntity,
    removeEntity,
    rebuildIndex,
  };
};
