import { sql } from "drizzle-orm";

import { searchDocumentsAccessSql } from "@/api/lib/search/contact-workspace-access-sql";
import { decodeCursor } from "@/api/lib/search/cursor";
import { TS_HEADLINE_CONFIG } from "@/api/lib/search/highlight";
import { buildSearchTsQuery } from "@/api/lib/search/query";
import { typedPgArray } from "@/api/lib/search/sql";
import { assertAuthorizedSearchScope } from "@/api/lib/search/types";
import type { ContentSearchQuery, SearchQuery } from "@/api/lib/search/types";

/**
 * Never expose a projection from before the live current version. Consumers
 * must alias search_documents as `sd` and join the current entity_versions row
 * as `ev` before interpolating this fragment.
 */
const currentVersionProjectionFilter = sql`
  AND sd.updated_at >= ev.created_at
`;

export const buildDocumentSearchQueries = (query: SearchQuery) => {
  assertAuthorizedSearchScope(query);

  const { organizationId, limit } = query;

  const orgFilter = sql`sd.organization_id = ${organizationId}`;
  const selectedWorkspaceIds =
    query.workspaceId === undefined ? [] : [query.workspaceId];
  const accessibleWorkspaceIds = query.workspaceIds ?? selectedWorkspaceIds;
  const workspaceAccessFilter = searchDocumentsAccessSql({
    accessibleWorkspaceIds,
    selectedWorkspaceIds: [],
  });
  const workspaceSelectionFilter = searchDocumentsAccessSql({
    accessibleWorkspaceIds,
    selectedWorkspaceIds,
  });
  const kindFilter =
    query.kinds && query.kinds.length > 0
      ? sql`AND sd.kind = ANY(${typedPgArray(query.kinds, "text")})`
      : sql``;

  // Use 'simple' config for the query so it matches any
  // document regardless of the per-document stemmer used at
  // index time. PG FTS still matches across configs when the
  // lexeme overlaps. For ranking and headlines, we use the
  // per-document language stored on the row.
  const tsQuery = buildSearchTsQuery(query.query);

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
    JOIN entities e ON e.id = sd.entity_id
    JOIN entity_versions ev ON ev.id = e.current_version_id
    JOIN workspaces w ON w.id = sd.workspace_id
    WHERE ${orgFilter}
      ${workspaceSelectionFilter}
      ${kindFilter}
      ${cursorFilter}
      ${currentVersionProjectionFilter}
      AND sd.tsv @@ ${tsQuery}
    ORDER BY score DESC, sd.entity_id DESC
    LIMIT ${limit + 1}
  `;

  const countQuery = sql`
    SELECT count(*)::int AS total
    FROM search_documents sd
    JOIN entities e ON e.id = sd.entity_id
    JOIN entity_versions ev ON ev.id = e.current_version_id
    WHERE ${orgFilter}
      ${workspaceSelectionFilter}
      ${kindFilter}
      ${currentVersionProjectionFilter}
      AND sd.tsv @@ ${tsQuery}
  `;

  // Facets use intentional cross-filtering: kind facet includes the
  // selected workspace, workspace facet does not. Both facets still
  // include the caller-visible workspace allowlist.
  const kindFacetQuery = sql`
    SELECT sd.kind AS value, count(*)::int AS count
    FROM search_documents sd
    JOIN entities e ON e.id = sd.entity_id
    JOIN entity_versions ev ON ev.id = e.current_version_id
    WHERE ${orgFilter}
      ${workspaceSelectionFilter}
      ${currentVersionProjectionFilter}
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
    JOIN entities e ON e.id = sd.entity_id
    JOIN entity_versions ev ON ev.id = e.current_version_id
    JOIN workspaces w ON w.id = sd.workspace_id
    WHERE ${orgFilter}
      ${workspaceAccessFilter}
      ${kindFilter}
      ${currentVersionProjectionFilter}
      AND sd.tsv @@ ${tsQuery}
    GROUP BY sd.workspace_id, w.name
    ORDER BY count DESC
  `;

  return { hitsQuery, countQuery, kindFacetQuery, workspaceFacetQuery };
};

const CONTENT_HEADLINE_CONFIG =
  "MaxWords=80, MinWords=30, MaxFragments=2, " +
  'FragmentDelimiter=" ... ", StartSel="", StopSel=""';

export const buildContentSearchQueries = (query: ContentSearchQuery) => {
  const { organizationId, workspaceId, limit } = query;
  const tsQuery = buildSearchTsQuery(query.query);
  const singleWorkspaceFilter = searchDocumentsAccessSql({
    accessibleWorkspaceIds: [workspaceId],
    selectedWorkspaceIds: [],
  });

  return {
    hitsQuery: sql`
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
      JOIN entities e ON e.id = sd.entity_id
      JOIN entity_versions ev ON ev.id = e.current_version_id
      WHERE sd.organization_id = ${organizationId}
        ${singleWorkspaceFilter}
        ${currentVersionProjectionFilter}
        AND sd.tsv @@ ${tsQuery}
      ORDER BY score DESC, sd.entity_id DESC
      LIMIT ${limit}
    `,
    countQuery: sql`
      SELECT count(*)::int AS total
      FROM search_documents sd
      JOIN entities e ON e.id = sd.entity_id
      JOIN entity_versions ev ON ev.id = e.current_version_id
      WHERE sd.organization_id = ${organizationId}
        ${singleWorkspaceFilter}
        ${currentVersionProjectionFilter}
        AND sd.tsv @@ ${tsQuery}
    `,
  };
};
