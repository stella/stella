import { and, asc, eq, gt, sql } from "drizzle-orm";

import { adminDb } from "@/api/db";
import { entities, searchDocuments } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";
import {
  escapeAndHighlight,
  HIGHLIGHT_START,
  HIGHLIGHT_STOP,
} from "@/api/lib/search/highlight";
import { upsertSearchDocument } from "@/api/lib/search/index-entity";
import { parseEntityKind } from "@/api/lib/search/types";
import type {
  ContentSearchHit,
  ContentSearchQuery,
  ContentSearchResult,
  FacetBucket,
  SearchHit,
  SearchProvider,
  SearchQuery,
  SearchResult,
} from "@/api/lib/search/types";

const REINDEX_BATCH_SIZE = 100;

type RawRow = Record<string, unknown>;

const mapHitRow = (row: RawRow): SearchHit => ({
  entityId: String(row.entity_id),
  workspaceId: String(row.workspace_id),
  workspaceName: String(row.workspace_name),
  kind: parseEntityKind(row.kind),
  title: String(row.title),
  headline: row.headline ? escapeAndHighlight(String(row.headline)) : null,
  updatedAt:
    row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : String(row.updated_at),
});

const search = async (query: SearchQuery): Promise<SearchResult> => {
  const { organizationId, limit } = query;

  const orgFilter = sql`sd.organization_id = ${organizationId}`;
  const wsFilter = query.workspaceId
    ? sql`AND sd.workspace_id = ${query.workspaceId}`
    : sql``;
  const kindFilter =
    query.kinds && query.kinds.length > 0
      ? sql`AND sd.kind = ANY(${query.kinds})`
      : sql``;

  // BM25 disjunction: matches documents containing any
  // search term. BM25 ranking naturally scores documents
  // with more matching terms higher.
  const textMatch = sql`(
    sd.title ||| ${query.query}
    OR sd.searchable_text ||| ${query.query}
  )`;

  const cursorFilter = query.cursor
    ? (() => {
        const parsed = decodeCursor(query.cursor);
        if (!parsed) {
          return sql``;
        }
        return sql`AND (
          pdb.score(sd.entity_id)::float8,
          sd.entity_id
        ) < (${parsed.score}::float8, ${parsed.id})`;
      })()
    : sql``;

  const hitsQuery = sql`
    SELECT
      sd.entity_id,
      sd.workspace_id,
      w.name AS workspace_name,
      sd.kind,
      sd.title,
      pdb.snippet(
        sd.searchable_text,
        start_tag => ${HIGHLIGHT_START},
        end_tag => ${HIGHLIGHT_STOP},
        max_num_chars => 200
      ) AS headline,
      pdb.score(sd.entity_id)::float8 AS score,
      sd.updated_at
    FROM search_documents sd
    JOIN workspaces w ON w.id = sd.workspace_id
    WHERE ${orgFilter}
      ${wsFilter}
      ${kindFilter}
      ${cursorFilter}
      AND ${textMatch}
    ORDER BY score DESC, sd.entity_id DESC
    LIMIT ${limit + 1}
  `;

  const countQuery = sql`
    SELECT count(*)::int AS total
    FROM search_documents sd
    WHERE ${orgFilter}
      ${wsFilter}
      ${kindFilter}
      AND ${textMatch}
  `;

  // Cross-filtered facets: kind facet respects workspace
  // selection, workspace facet respects kind selection.
  const kindFacetQuery = sql`
    SELECT sd.kind AS value, count(*)::int AS count
    FROM search_documents sd
    WHERE ${orgFilter}
      ${wsFilter}
      AND ${textMatch}
    GROUP BY sd.kind
    ORDER BY count DESC
  `;

  const workspaceFacetQuery = sql`
    SELECT
      sd.workspace_id AS value,
      w.name AS label,
      count(*)::int AS count
    FROM search_documents sd
    JOIN workspaces w ON w.id = sd.workspace_id
    WHERE ${orgFilter}
      ${kindFilter}
      AND ${textMatch}
    GROUP BY sd.workspace_id, w.name
    ORDER BY count DESC
  `;

  const [hitsResult, countResult, kindResult, wsResult] = await Promise.all([
    adminDb.execute(hitsQuery),
    adminDb.execute(countQuery),
    adminDb.execute(kindFacetQuery),
    adminDb.execute(workspaceFacetQuery),
  ]);

  const hasMore = hitsResult.rows.length > limit;
  const resultRows = hasMore
    ? hitsResult.rows.slice(0, limit)
    : hitsResult.rows;

  const lastRaw = resultRows.at(-1);
  const nextCursor =
    hasMore && lastRaw
      ? encodeCursor(Number(lastRaw.score), String(lastRaw.entity_id))
      : null;

  const hits: SearchHit[] = resultRows.map(mapHitRow);
  const totalCount = Number(countResult.rows.at(0)?.total) || 0;

  const kindFacets: FacetBucket[] = kindResult.rows.map((row) => ({
    value: String(row.value),
    count: Number(row.count),
  }));

  const workspaceFacets: FacetBucket[] = wsResult.rows.map((row) => ({
    value: String(row.value),
    label: String(row.label),
    count: Number(row.count),
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
): Promise<ContentSearchResult> => {
  const { organizationId, workspaceId, limit } = query;

  const textMatch = sql`sd.searchable_text ||| ${query.query}`;

  const [hitsResult, countResult] = await Promise.all([
    adminDb.execute(sql`
      SELECT
        sd.entity_id,
        sd.kind,
        sd.title,
        pdb.snippet(
          sd.searchable_text,
          start_tag => '',
          end_tag => '',
          max_num_chars => 400
        ) AS passage,
        pdb.score(sd.entity_id)::float8 AS score
      FROM search_documents sd
      WHERE sd.organization_id = ${organizationId}
        AND sd.workspace_id = ${workspaceId}
        AND ${textMatch}
      ORDER BY score DESC, sd.entity_id DESC
      LIMIT ${limit}
    `),
    adminDb.execute(sql`
      SELECT count(*)::int AS total
      FROM search_documents sd
      WHERE sd.organization_id = ${organizationId}
        AND sd.workspace_id = ${workspaceId}
        AND ${textMatch}
    `),
  ]);

  const hits: ContentSearchHit[] = hitsResult.rows.map((row) => ({
    entityId: String(row.entity_id),
    kind: parseEntityKind(row.kind),
    title: String(row.title),
    passage: row.passage ? String(row.passage) : "",
  }));

  const totalCount = Number(countResult.rows.at(0)?.total) || 0;

  return { hits, totalCount };
};

const indexEntity = async (entityId: string): Promise<void> => {
  await upsertSearchDocument(entityId);
};

const removeEntity = async (entityId: string): Promise<void> => {
  await adminDb
    .delete(searchDocuments)
    .where(eq(searchDocuments.entityId, entityId));
};

const rebuildIndex = async (orgId: SafeId<"organization">): Promise<void> => {
  const orgWorkspaces = await adminDb.query.workspaces.findMany({
    where: { organizationId: { eq: orgId } },
    columns: { id: true },
    limit: LIMITS.workspacesCount,
  });

  for (const ws of orgWorkspaces) {
    const wsId = toSafeId<"workspace">(ws.id);
    let lastId = "";
    let hasMore = true;
    while (hasMore) {
      const batch = await adminDb
        .select({ id: entities.id })
        .from(entities)
        .where(
          lastId
            ? and(eq(entities.workspaceId, wsId), gt(entities.id, lastId))
            : eq(entities.workspaceId, wsId),
        )
        .orderBy(asc(entities.id))
        .limit(REINDEX_BATCH_SIZE);

      for (const entity of batch) {
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

export const paradedbProvider: SearchProvider = {
  search,
  searchContent,
  indexEntity,
  removeEntity,
  rebuildIndex,
};
