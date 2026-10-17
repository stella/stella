import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { encodeCursor } from "@/api/lib/search/cursor";
import { escapeAndHighlight } from "@/api/lib/search/highlight";
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
  SearchHit,
  SearchQuery,
  SearchReader,
  SearchResult,
} from "@/api/lib/search/types";

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
