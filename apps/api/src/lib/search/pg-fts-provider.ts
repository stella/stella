import { and, asc, eq, gt, sql } from "drizzle-orm";

import { db } from "@/api/db";
import { entities, searchDocuments } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";
import {
  escapeAndHighlight,
  TS_HEADLINE_CONFIG,
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
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- row.headline from DB (any)
  headline: row.headline
    ? escapeAndHighlight(JSON.stringify(row.headline))
    : null,
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

  // Use 'simple' config for the query so it matches any
  // document regardless of the per-document stemmer used at
  // index time. PG FTS still matches across configs when the
  // lexeme overlaps. For ranking and headlines, we use the
  // per-document language stored on the row.
  const tsQuery = sql`plainto_tsquery('simple', ${query.query})`;

  const cursorFilter = query.cursor
    ? (() => {
        const parsed = decodeCursor(query.cursor);
        if (!parsed) {
          return sql``;
        }
        // Cast to float8 to avoid float4→float64 precision loss
        return sql`AND (ts_rank(sd.tsv, ${tsQuery})::float8, sd.entity_id) < (${parsed.score}::float8, ${parsed.id})`;
      })()
    : sql``;

  const hitsQuery = sql`
    SELECT
      sd.entity_id,
      sd.workspace_id,
      w.name AS workspace_name,
      sd.kind,
      sd.title,
      ts_headline(
        coalesce(sd.language, 'simple')::regconfig,
        sd.title || ' ' || left(sd.searchable_text, 2000),
        ${tsQuery},
        ${TS_HEADLINE_CONFIG}
      ) AS headline,
      ts_rank(sd.tsv, ${tsQuery})::float8 AS score,
      sd.updated_at
    FROM search_documents sd
    JOIN workspaces w ON w.id = sd.workspace_id
    WHERE ${orgFilter}
      ${wsFilter}
      ${kindFilter}
      ${cursorFilter}
      AND sd.tsv @@ ${tsQuery}
    ORDER BY score DESC, sd.entity_id DESC
    LIMIT ${limit + 1}
  `;

  const countQuery = sql`
    SELECT count(*)::int AS total
    FROM search_documents sd
    WHERE ${orgFilter}
      ${wsFilter}
      ${kindFilter}
      AND sd.tsv @@ ${tsQuery}
  `;

  // Facets use intentional cross-filtering: kind facet includes
  // wsFilter (counts reflect workspace selection), workspace facet
  // includes kindFilter (counts reflect kind selection).
  const kindFacetQuery = sql`
    SELECT sd.kind AS value, count(*)::int AS count
    FROM search_documents sd
    WHERE ${orgFilter}
      ${wsFilter}
      AND sd.tsv @@ ${tsQuery}
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
      AND sd.tsv @@ ${tsQuery}
    GROUP BY sd.workspace_id, w.name
    ORDER BY count DESC
  `;

  // All four queries are independent; run in parallel.
  const [hitsResult, countResult, kindResult, wsResult] = await Promise.all([
    db.execute(hitsQuery),
    db.execute(countQuery),
    db.execute(kindFacetQuery),
    db.execute(workspaceFacetQuery),
  ]);

  const hasMore = hitsResult.rows.length > limit;
  const resultRows = hasMore
    ? hitsResult.rows.slice(0, limit)
    : hitsResult.rows;

  // Compute cursor from raw row (score is internal, not exposed)
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

const CONTENT_HEADLINE_CONFIG =
  "MaxWords=80, MinWords=30, MaxFragments=2, " +
  'FragmentDelimiter=" ... ", StartSel="", StopSel=""';

const searchContent = async (
  query: ContentSearchQuery,
): Promise<ContentSearchResult> => {
  const { organizationId, workspaceId, limit } = query;
  const tsQuery = sql`plainto_tsquery('simple', ${query.query})`;

  const [hitsResult, countResult] = await Promise.all([
    db.execute(sql`
      SELECT
        sd.entity_id,
        sd.kind,
        sd.title,
        ts_headline(
          coalesce(sd.language, 'simple')::regconfig,
          left(sd.searchable_text, 10000),
          ${tsQuery},
          ${CONTENT_HEADLINE_CONFIG}
        ) AS passage,
        ts_rank(sd.tsv, ${tsQuery})::float8 AS score
      FROM search_documents sd
      WHERE sd.organization_id = ${organizationId}
        AND sd.workspace_id = ${workspaceId}
        AND sd.tsv @@ ${tsQuery}
      ORDER BY score DESC, sd.entity_id DESC
      LIMIT ${limit}
    `),
    db.execute(sql`
      SELECT count(*)::int AS total
      FROM search_documents sd
      WHERE sd.organization_id = ${organizationId}
        AND sd.workspace_id = ${workspaceId}
        AND sd.tsv @@ ${tsQuery}
    `),
  ]);

  const hits: ContentSearchHit[] = hitsResult.rows.map((row) => ({
    entityId: String(row.entity_id),
    kind: parseEntityKind(row.kind),
    title: String(row.title),
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- row.passage from DB (any)
    passage: row.passage ? JSON.stringify(row.passage) : "",
  }));

  const totalCount = Number(countResult.rows.at(0)?.total) || 0;

  return { hits, totalCount };
};

const indexEntity = async (entityId: string): Promise<void> => {
  await upsertSearchDocument(entityId);
};

const removeEntity = async (entityId: string): Promise<void> => {
  await db
    .delete(searchDocuments)
    .where(eq(searchDocuments.entityId, entityId));
};

// Upsert all entities without deleting first to avoid search
// blackout. CASCADE FK handles deleted entities' search docs.
const rebuildIndex = async (orgId: SafeId<"organization">): Promise<void> => {
  const orgWorkspaces = await db.query.workspaces.findMany({
    where: { organizationId: { eq: orgId } },
    columns: { id: true },
    limit: LIMITS.workspacesCount,
  });

  for (const ws of orgWorkspaces) {
    const wsId = toSafeId<"workspace">(ws.id);
    let lastId = "";
    let hasMore = true;
    while (hasMore) {
      // Keyset pagination: O(1) per batch vs O(N) for offset
      const batch = await db
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

export const pgFtsProvider: SearchProvider = {
  search,
  searchContent,
  indexEntity,
  removeEntity,
  rebuildIndex,
};
