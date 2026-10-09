import { and, asc, eq, gt } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { entities, searchDocuments } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { encodeCursor } from "@/api/lib/search/cursor";
import { escapeAndHighlight } from "@/api/lib/search/highlight";
import { upsertSearchDocument } from "@/api/lib/search/index-entity";
import { syncWorkspaceSearchActivity } from "@/api/lib/search/index-global";
import {
  buildDocumentSearchQueries,
  buildContentSearchQueries,
} from "@/api/lib/search/pg-fts-search-query";
import { parseEntityKind } from "@/api/lib/search/types";
import type {
  ContentSearchHit,
  ContentSearchQuery,
  ContentSearchResult,
  FacetBucket,
  RemoveEntityOptions,
  SearchHit,
  SearchMaintenance,
  SearchQuery,
  SearchReader,
  SearchResult,
} from "@/api/lib/search/types";

const REINDEX_BATCH_SIZE = 100;

type RawRow = Record<string, unknown>;
type SearchDatabase = Pick<Transaction, "execute">;

export const mapHitRow = (row: RawRow): SearchHit => ({
  entityId: String(row["entity_id"]),
  workspaceId: String(row["workspace_id"]),
  workspaceName: String(row["workspace_name"]),
  kind: parseEntityKind(row["kind"]),
  title: String(row["title"]),
  headline:
    typeof row["headline"] === "string" && row["headline"].length > 0
      ? escapeAndHighlight(row["headline"])
      : null,
  updatedAt:
    row["updated_at"] instanceof Date
      ? row["updated_at"].toISOString()
      : String(row["updated_at"]),
});

const search = async (
  query: SearchQuery,
  database: SearchDatabase,
): Promise<SearchResult> => {
  const { hitsQuery, countQuery, kindFacetQuery, workspaceFacetQuery } =
    buildDocumentSearchQueries(query);
  const { limit } = query;

  // All four queries are independent; run in parallel.
  const [hitsResult, countResult, kindResult, wsResult] = await Promise.all([
    database.execute(hitsQuery),
    database.execute(countQuery),
    database.execute(kindFacetQuery),
    database.execute(workspaceFacetQuery),
  ]);

  const hasMore = hitsResult.length > limit;
  const resultRows = hasMore ? hitsResult.slice(0, limit) : hitsResult;

  // Compute cursor from raw row (score is internal, not exposed)
  const lastRaw = resultRows.at(-1);
  const nextCursor =
    hasMore && lastRaw
      ? encodeCursor(Number(lastRaw["score"]), String(lastRaw["entity_id"]))
      : null;

  const hits: SearchHit[] = resultRows.map(mapHitRow);
  const totalCount = Number(countResult.at(0)?.["total"]) || 0;

  const kindFacets: FacetBucket[] = kindResult.map((row: RawRow) => ({
    value: String(row["value"]),
    count: Number(row["count"]),
  }));

  const workspaceFacets: FacetBucket[] = wsResult.map((row: RawRow) => ({
    value: String(row["value"]),
    label: String(row["label"]),
    count: Number(row["count"]),
  }));

  return {
    hits,
    facets: {
      kind: kindFacets,
      workspace: workspaceFacets,
    },
    totalCount,
    nextCursor,
  };
};

const searchContent = async (
  query: ContentSearchQuery,
  database: SearchDatabase,
): Promise<ContentSearchResult> => {
  const { hitsQuery, countQuery } = buildContentSearchQueries(query);
  const [hitsResult, countResult] = await Promise.all([
    database.execute(hitsQuery),
    database.execute(countQuery),
  ]);

  const hits: ContentSearchHit[] = hitsResult.map((row: RawRow) => ({
    entityId: String(row["entity_id"]),
    kind: parseEntityKind(row["kind"]),
    title: String(row["title"]),
    passage:
      typeof row["passage"] === "string" && row["passage"].length > 0
        ? JSON.stringify(row["passage"])
        : "",
  }));

  const totalCount = Number(countResult.at(0)?.["total"]) || 0;

  return { hits, totalCount };
};

const indexEntity = async (entityId: SafeId<"entity">): Promise<void> => {
  await upsertSearchDocument(entityId);
};

const removeEntity = async ({
  entityId,
  workspaceId,
}: RemoveEntityOptions): Promise<void> => {
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

/**
 * Reads run in one transaction per call on the caller's scoped handle. The
 * reader carries no index maintenance, so an injected handle never travels
 * with owner-level writes.
 */
export const createPgFtsSearchReader = (scopedDb: ScopedDb): SearchReader => ({
  search: async (query) =>
    await scopedDb(async (tx) => await search(query, tx)),
  searchContent: async (query) =>
    await scopedDb(async (tx) => await searchContent(query, tx)),
});

export const pgFtsSearchMaintenance: SearchMaintenance = {
  indexEntity,
  removeEntity,
  rebuildIndex,
};
