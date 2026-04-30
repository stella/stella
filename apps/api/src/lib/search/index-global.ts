import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { db } from "@/api/db/root";
import { contacts, workspaceContacts, workspaces } from "@/api/db/schema";
import type {
  ContactAddress,
  ContactEmail,
  ContactPhone,
} from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { decodeCursor } from "@/api/lib/search/cursor";
import {
  escapeAndHighlight,
  TS_HEADLINE_CONFIG,
} from "@/api/lib/search/highlight";
import {
  GLOBAL_SEARCH_MAX_OFFSET,
  resolveGlobalSearchNextCursor,
} from "@/api/lib/search/pagination";
import { buildSearchTsQuery } from "@/api/lib/search/query";
import { typedPgArray } from "@/api/lib/search/sql";
import { parseEntityKind } from "@/api/lib/search/types";
import type {
  ContactGlobalSearchHit,
  EntityGlobalSearchHit,
  FacetBucket,
  GlobalSearchHit,
  GlobalSearchResult,
  GlobalSearchResultType,
  MatterGlobalSearchHit,
} from "@/api/lib/search/types";

const REINDEX_BATCH_SIZE = 100;
const WORKSPACE_REINDEX_CONCURRENCY = 4;
const GLOBAL_SEARCH_FACET_LIMIT = 20;

type RawRow = Record<string, unknown>;
type CountRow = { total?: unknown };

type ScoredGlobalSearchHit = {
  hit: GlobalSearchHit;
  score: number;
};

type SearchPromise = Promise<RawRow[]>;

export type GlobalSearchQuery = {
  query: string;
  organizationId: SafeId<"organization">;
  workspaceIds: readonly SafeId<"workspace">[];
  workspaceId?: SafeId<"workspace"> | undefined;
  types?: readonly GlobalSearchResultType[] | undefined;
  editedByUserId?: string | undefined;
  mimeTypes?: readonly string[] | undefined;
  updatedAfter?: string | undefined;
  cursor?: string | undefined;
  limit: number;
};

const compact = (parts: readonly (string | null | undefined)[]): string =>
  parts
    .flatMap((part) => {
      const trimmed = part?.trim();
      return trimmed ? [trimmed] : [];
    })
    .join(" ");

const emailsToText = (emails: readonly ContactEmail[] | null | undefined) =>
  compact(emails?.flatMap((email) => [email.address, email.label]) ?? []);

const phonesToText = (phones: readonly ContactPhone[] | null | undefined) =>
  compact(phones?.flatMap((phone) => [phone.number, phone.label]) ?? []);

const addressesToText = (
  addresses: readonly ContactAddress[] | null | undefined,
) =>
  compact(
    addresses?.flatMap((address) => [
      address.line1,
      address.line2,
      address.city,
      address.state,
      address.postalCode,
      address.country,
      address.label,
    ]) ?? [],
  );

const tagsToText = (tags: readonly string[] | null | undefined) =>
  compact(tags ?? []);

const toIso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

const latestDate = (
  values: readonly (Date | null | undefined)[],
): Date | null => {
  let latest: Date | null = null;
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (!latest || value.getTime() > latest.getTime()) {
      latest = value;
    }
  }
  return latest;
};

const toNullableString = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
};

const toHeadline = (value: unknown): string | null => {
  const text = toNullableString(value);
  // `ts_headline` is configured with non-HTML markers; escape user text first,
  // then swap only those sentinel markers for <mark> tags.
  return text === null ? null : escapeAndHighlight(text);
};

const selectedTypes = (types: readonly GlobalSearchResultType[] | undefined) =>
  new Set<GlobalSearchResultType>(types);

const shouldSearchType = (
  selected: ReadonlySet<GlobalSearchResultType>,
  type: GlobalSearchResultType,
) => selected.size === 0 || selected.has(type);

const hasSelectedEntityType = (selected: ReadonlySet<GlobalSearchResultType>) =>
  selected.size === 0 ||
  [...selected].some(
    (type) => type !== "matter" && type !== "contact" && type !== "case-law",
  );

const fileFieldJoin = sql`
  LEFT JOIN LATERAL (
    SELECT
      (array_agg(DISTINCT files.mime_type ORDER BY files.mime_type))[1] AS mime_type,
      array_agg(DISTINCT files.mime_type ORDER BY files.mime_type) AS mime_types
    FROM (
      SELECT field_content.content ->> 'mimeType' AS mime_type
      FROM fields f
      CROSS JOIN LATERAL (
        SELECT CASE jsonb_typeof(f.content)
          WHEN 'object' THEN f.content
          WHEN 'string' THEN (f.content #>> '{}')::jsonb
          ELSE NULL::jsonb
        END AS content
      ) field_content
      WHERE f.workspace_id = sd.workspace_id
        AND f.entity_version_id = e.current_version_id
        AND field_content.content ->> 'type' = 'file'
        AND nullif(field_content.content ->> 'mimeType', '') IS NOT NULL
    ) files
  ) file_field ON true
`;

const caseLawBodyPreviewJoin = sql`
  LEFT JOIN LATERAL (
    SELECT string_agg(
      section_item.value ->> 'text',
      ' '
      ORDER BY (section_item.value ->> 'index')::int
    ) AS text
    FROM jsonb_array_elements(
      CASE jsonb_typeof(d.sections)
        WHEN 'array' THEN d.sections
        ELSE '[]'::jsonb
      END
    ) section_item(value)
    WHERE section_item.value ->> 'type' <> 'header'
      AND nullif(section_item.value ->> 'text', '') IS NOT NULL
  ) body_preview ON true
`;

const headlineRegconfig = sql`
  'public.stella_unaccent'::regconfig
`;

const workspaceAccessSql = ({
  column = sql`workspace_id`,
  workspaceId,
  workspaceIds,
}: Pick<GlobalSearchQuery, "workspaceId" | "workspaceIds"> & {
  column?: SQL;
}) => {
  if (workspaceIds.length === 0) {
    return sql`AND false`;
  }

  const workspaceIdsSql = typedPgArray(workspaceIds, "uuid");

  if (workspaceId) {
    return sql`AND ${column} = ${workspaceId}
      AND ${column} = ANY(${workspaceIdsSql})`;
  }

  return sql`AND ${column} = ANY(${workspaceIdsSql})`;
};

const mapEntityHit = (row: RawRow): ScoredGlobalSearchHit => {
  const kind = parseEntityKind(row["type"]);
  const entityId = String(row["id"]);
  const workspaceId = String(row["workspace_id"]);
  const hit: EntityGlobalSearchHit = {
    id: `entity:${entityId}`,
    type: kind,
    entityId,
    workspaceId,
    workspaceName: String(row["workspace_name"]),
    title: String(row["title"]),
    headline: toHeadline(row["headline"]),
    updatedAt: toIso(row["updated_at"]),
    lastEditedByName: toNullableString(row["last_edited_by_name"]),
    lastEditedByImage: toNullableString(row["last_edited_by_image"]),
    mimeType: toNullableString(row["mime_type"]),
  };

  return { hit, score: Number(row["score"]) };
};

const mapMatterHit = (row: RawRow): ScoredGlobalSearchHit => {
  const workspaceId = String(row["id"]);
  const hit: MatterGlobalSearchHit = {
    id: `matter:${workspaceId}`,
    type: "matter",
    workspaceId,
    workspaceName: String(row["title"]),
    title: String(row["title"]),
    headline: toHeadline(row["headline"]),
    updatedAt: toIso(row["updated_at"]),
  };

  return { hit, score: Number(row["score"]) + 0.15 };
};

const mapContactHit = (row: RawRow): ScoredGlobalSearchHit => {
  const contactId = String(row["id"]);
  const contactType = String(row["contact_type"]);
  const hit: ContactGlobalSearchHit = {
    id: `contact:${contactId}`,
    type: "contact",
    contactId,
    contactType: contactType === "organization" ? "organization" : "person",
    title: String(row["title"]),
    headline: toHeadline(row["headline"]),
    updatedAt: toIso(row["updated_at"]),
  };

  return { hit, score: Number(row["score"]) };
};

const mapCaseLawHit = (row: RawRow): ScoredGlobalSearchHit => {
  const decisionId = String(row["id"]);
  const hit: GlobalSearchHit = {
    id: `case-law:${decisionId}`,
    type: "case-law",
    decisionId,
    caseNumber: String(row["case_number"]),
    court: String(row["court"]),
    country: String(row["country"]),
    decisionDate: toNullableString(row["decision_date"]),
    title: `${String(row["case_number"])} - ${String(row["court"])}`,
    headline: toHeadline(row["headline"]),
    updatedAt: toIso(row["updated_at"]),
  };

  return { hit, score: Number(row["score"]) };
};

const facet = (
  map: Map<string, { label?: string | undefined; count: number }>,
): FacetBucket[] =>
  [...map.entries()]
    .map(([value, data]) => {
      const bucket: FacetBucket = { value, count: data.count };
      if (data.label !== undefined) {
        bucket.label = data.label;
      }
      return bucket;
    })
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

const totalFrom = (rows: CountRow[]): number => Number(rows.at(0)?.total ?? 0);

const rowsWhen = async (
  condition: boolean,
  query: () => SearchPromise,
): SearchPromise => {
  if (!condition) {
    return [];
  }
  return await query();
};

const countWhen = async (
  condition: boolean,
  query: () => Promise<CountRow[]>,
): Promise<CountRow[]> => {
  if (!condition) {
    return [{ total: 0 }];
  }
  return await query();
};

const sqlWhen = (condition: boolean, fragment: () => SQL): SQL =>
  condition ? fragment() : sql``;

const emptyWorkspaceFacetQuery = sql`
  SELECT NULL::uuid AS value, NULL::text AS label WHERE false
`;

export const contactWorkspaceAccessSql = ({
  organizationId,
  workspaceId,
  workspaceIds,
}: {
  organizationId: SafeId<"organization">;
  workspaceId?: SafeId<"workspace"> | undefined;
  workspaceIds: readonly SafeId<"workspace">[];
}): SQL => {
  if (workspaceIds.length === 0) {
    return sql`AND false`;
  }

  const workspaceFilter = workspaceId ? sql`AND w.id = ${workspaceId}` : sql``;

  return sql`AND EXISTS (
        SELECT 1
        FROM workspaces w
        LEFT JOIN workspace_contacts wc
          ON wc.workspace_id = w.id
        WHERE w.id = ANY(${typedPgArray(workspaceIds, "uuid")})
          ${workspaceFilter}
          AND w.organization_id = ${organizationId}
          AND (
            w.client_id = csd.contact_id
            OR wc.contact_id = csd.contact_id
          )
      )`;
};

const toStringFacetMap = (
  rows: RawRow[],
): Map<string, { label: string; count: number }> => {
  const map = new Map<string, { label: string; count: number }>();
  for (const row of rows) {
    const value = row["value"];
    const label = row["label"];
    if (typeof value !== "string" || typeof label !== "string") {
      continue;
    }
    map.set(value, { label, count: Number(row["count"]) });
  }
  return map;
};

const toMimeTypeFacetMap = (
  rows: RawRow[],
): Map<string, { label: string; count: number }> => {
  const map = new Map<string, { label: string; count: number }>();
  for (const row of rows) {
    const value = row["value"];
    if (typeof value !== "string") {
      continue;
    }
    map.set(value, { label: value, count: Number(row["count"]) });
  }
  return map;
};

const globalSearchOffset = (cursor: string | undefined): number => {
  const parsedCursor = cursor ? decodeCursor(cursor) : null;
  if (parsedCursor?.id !== "global") {
    return 0;
  }

  return Math.max(
    0,
    Math.min(GLOBAL_SEARCH_MAX_OFFSET, Math.floor(parsedCursor.score)),
  );
};

// oxlint-disable-next-line sonarjs/cognitive-complexity -- global search composes parallel scoped result queries and facets in one bounded round-trip
export const searchGlobal = async ({
  query,
  organizationId,
  workspaceIds,
  workspaceId,
  types,
  editedByUserId,
  mimeTypes,
  updatedAfter,
  cursor,
  limit,
}: GlobalSearchQuery): Promise<GlobalSearchResult> => {
  const selected = selectedTypes(types);
  const restrictToEntities =
    editedByUserId !== undefined || (mimeTypes?.length ?? 0) > 0;
  const offset = globalSearchOffset(cursor);
  const fetchLimit = offset + limit;
  const tsQuery = buildSearchTsQuery(query);
  const entityWorkspaceFilter = workspaceAccessSql({
    column: sql`sd.workspace_id`,
    workspaceId,
    workspaceIds,
  });
  const matterWorkspaceFilter = workspaceAccessSql({
    column: sql`wsd.workspace_id`,
    workspaceId,
    workspaceIds,
  });
  const contactWorkspaceFilter = contactWorkspaceAccessSql({
    organizationId,
    workspaceId,
    workspaceIds,
  });
  const entityTypes = [...selected].filter(
    (type) => type !== "matter" && type !== "contact" && type !== "case-law",
  );
  const hasMimeTypeFilter = mimeTypes !== undefined && mimeTypes.length > 0;
  const mimeTypeFilterValues = mimeTypes ?? [];
  const entityEditorFilter = sqlWhen(
    editedByUserId !== undefined,
    () => sql`AND e.last_edited_by = ${editedByUserId}`,
  );
  const entityMimeFilter = sqlWhen(
    hasMimeTypeFilter,
    () =>
      sql`AND file_field.mime_types && ${typedPgArray(mimeTypeFilterValues, "text")}`,
  );
  const entityUpdatedFilter = sqlWhen(
    updatedAfter !== undefined,
    () => sql`AND sd.updated_at >= ${updatedAfter}`,
  );
  const matterUpdatedFilter = sqlWhen(
    updatedAfter !== undefined,
    () => sql`AND wsd.updated_at >= ${updatedAfter}`,
  );
  const contactUpdatedFilter = sqlWhen(
    updatedAfter !== undefined,
    () => sql`AND csd.updated_at >= ${updatedAfter}`,
  );
  const caseLawUpdatedFilter = sqlWhen(
    updatedAfter !== undefined,
    () => sql`AND clsd.updated_at >= ${updatedAfter}`,
  );
  const entityTypeFilter = sqlWhen(
    selected.size > 0,
    () => sql`AND sd.kind = ANY(${typedPgArray(entityTypes, "entity_kind")})`,
  );

  const entityPromise = rowsWhen(hasSelectedEntityType(selected), () =>
    db.execute(sql`
      SELECT
        sd.entity_id AS id,
        sd.workspace_id,
        w.name AS workspace_name,
        sd.kind AS type,
        sd.title,
        editor.name AS last_edited_by_name,
        editor.image AS last_edited_by_image,
        file_field.mime_type,
        ts_headline(
          ${headlineRegconfig},
          sd.title || ' ' || left(sd.searchable_text, 2000),
          ${tsQuery},
          ${TS_HEADLINE_CONFIG}
        ) AS headline,
        ts_rank(sd.tsv, ${tsQuery})::float8 AS score,
        sd.updated_at
      FROM search_documents sd
      JOIN workspaces w ON w.id = sd.workspace_id
      LEFT JOIN entities e
        ON e.id = sd.entity_id
        AND e.workspace_id = sd.workspace_id
      LEFT JOIN "user" editor ON editor.id = e.last_edited_by
      ${fileFieldJoin}
      WHERE sd.organization_id = ${organizationId}
        ${entityWorkspaceFilter}
        ${entityTypeFilter}
        ${entityEditorFilter}
        ${entityMimeFilter}
        ${entityUpdatedFilter}
        AND sd.tsv @@ ${tsQuery}
      ORDER BY score DESC, sd.entity_id DESC
      LIMIT ${fetchLimit}
    `),
  );

  const matterPromise = rowsWhen(
    !restrictToEntities && shouldSearchType(selected, "matter"),
    () =>
      db.execute(sql`
      SELECT
        wsd.workspace_id AS id,
        wsd.title,
        ts_headline(
          ${headlineRegconfig},
          wsd.title || ' ' || left(wsd.searchable_text, 2000),
          ${tsQuery},
          ${TS_HEADLINE_CONFIG}
        ) AS headline,
        ts_rank(wsd.tsv, ${tsQuery})::float8 AS score,
        wsd.updated_at
      FROM workspace_search_documents wsd
      WHERE wsd.organization_id = ${organizationId}
        ${matterWorkspaceFilter}
        ${matterUpdatedFilter}
        AND wsd.tsv @@ ${tsQuery}
      ORDER BY score DESC, wsd.workspace_id DESC
      LIMIT ${fetchLimit}
    `),
  );

  const contactPromise = rowsWhen(
    !restrictToEntities &&
      workspaceIds.length > 0 &&
      shouldSearchType(selected, "contact"),
    () =>
      db.execute(sql`
      SELECT
        csd.contact_id AS id,
        csd.contact_type,
        csd.title,
        ts_headline(
          ${headlineRegconfig},
          csd.title || ' ' || left(csd.searchable_text, 2000),
          ${tsQuery},
          ${TS_HEADLINE_CONFIG}
        ) AS headline,
        ts_rank(csd.tsv, ${tsQuery})::float8 AS score,
        csd.updated_at
      FROM contact_search_documents csd
      WHERE csd.organization_id = ${organizationId}
        ${contactWorkspaceFilter}
        ${contactUpdatedFilter}
        AND csd.tsv @@ ${tsQuery}
      ORDER BY score DESC, csd.contact_id DESC
      LIMIT ${fetchLimit}
    `),
  );

  const caseLawPromise = rowsWhen(
    !restrictToEntities && shouldSearchType(selected, "case-law"),
    () =>
      db.execute(sql`
      SELECT
        clsd.decision_id AS id,
        d.case_number,
        d.court,
        d.country,
        d.decision_date,
        ts_headline(
          ${headlineRegconfig},
          coalesce(nullif(body_preview.text, ''), d.fulltext, clsd.searchable_text),
          ${tsQuery},
          ${TS_HEADLINE_CONFIG}
        ) AS headline,
        ts_rank(clsd.tsv, ${tsQuery})::float8 AS score,
        clsd.updated_at
      FROM case_law_search_documents clsd
      JOIN case_law_decisions d ON d.id = clsd.decision_id
      ${caseLawBodyPreviewJoin}
      WHERE clsd.tsv @@ ${tsQuery}
        ${caseLawUpdatedFilter}
      ORDER BY score DESC, clsd.decision_id DESC
      LIMIT ${fetchLimit}
    `),
  );

  const countPromises = [
    countWhen(hasSelectedEntityType(selected), () =>
      db.execute(sql`
        SELECT count(*)::int AS total
        FROM search_documents sd
        LEFT JOIN entities e
          ON e.id = sd.entity_id
          AND e.workspace_id = sd.workspace_id
        ${fileFieldJoin}
        WHERE sd.organization_id = ${organizationId}
          ${entityWorkspaceFilter}
          ${entityTypeFilter}
          ${entityEditorFilter}
          ${entityMimeFilter}
          ${entityUpdatedFilter}
          AND sd.tsv @@ ${tsQuery}
      `),
    ),
    countWhen(!restrictToEntities && shouldSearchType(selected, "matter"), () =>
      db.execute(sql`
        SELECT count(*)::int AS total
        FROM workspace_search_documents wsd
        WHERE wsd.organization_id = ${organizationId}
          ${matterWorkspaceFilter}
          ${matterUpdatedFilter}
          AND wsd.tsv @@ ${tsQuery}
      `),
    ),
    countWhen(
      !restrictToEntities &&
        workspaceIds.length > 0 &&
        shouldSearchType(selected, "contact"),
      () =>
        db.execute(sql`
        SELECT count(*)::int AS total
        FROM contact_search_documents csd
        WHERE csd.organization_id = ${organizationId}
          ${contactWorkspaceFilter}
          ${contactUpdatedFilter}
          AND csd.tsv @@ ${tsQuery}
      `),
    ),
    countWhen(
      !restrictToEntities && shouldSearchType(selected, "case-law"),
      () =>
        db.execute(sql`
        SELECT count(*)::int AS total
        FROM case_law_search_documents clsd
        WHERE clsd.tsv @@ ${tsQuery}
          ${caseLawUpdatedFilter}
      `),
    ),
  ] as const;

  const entityTypeFacetPromise = rowsWhen(hasSelectedEntityType(selected), () =>
    db.execute(sql`
      SELECT sd.kind AS value, count(*)::int AS count
      FROM search_documents sd
      LEFT JOIN entities e
        ON e.id = sd.entity_id
        AND e.workspace_id = sd.workspace_id
      ${fileFieldJoin}
      WHERE sd.organization_id = ${organizationId}
        ${entityWorkspaceFilter}
        ${entityEditorFilter}
        ${entityMimeFilter}
        ${entityUpdatedFilter}
        AND sd.tsv @@ ${tsQuery}
      GROUP BY sd.kind
      ORDER BY count DESC, sd.kind ASC
      LIMIT ${GLOBAL_SEARCH_FACET_LIMIT}
    `),
  );

  const matterTypeFacetCountPromise = countWhen(!restrictToEntities, () =>
    db.execute(sql`
      SELECT count(*)::int AS total
      FROM workspace_search_documents wsd
      WHERE wsd.organization_id = ${organizationId}
        ${matterWorkspaceFilter}
        ${matterUpdatedFilter}
        AND wsd.tsv @@ ${tsQuery}
    `),
  );

  const contactTypeFacetCountPromise = countWhen(
    !restrictToEntities && workspaceIds.length > 0,
    () =>
      db.execute(sql`
        SELECT count(*)::int AS total
        FROM contact_search_documents csd
        WHERE csd.organization_id = ${organizationId}
          ${contactWorkspaceFilter}
          ${contactUpdatedFilter}
          AND csd.tsv @@ ${tsQuery}
      `),
  );

  const caseLawTypeFacetCountPromise = countWhen(!restrictToEntities, () =>
    db.execute(sql`
      SELECT count(*)::int AS total
      FROM case_law_search_documents clsd
      WHERE clsd.tsv @@ ${tsQuery}
        ${caseLawUpdatedFilter}
    `),
  );

  const entityWorkspaceFacetQuery = hasSelectedEntityType(selected)
    ? sql`
      SELECT sd.workspace_id AS value, w.name AS label
      FROM search_documents sd
      JOIN workspaces w ON w.id = sd.workspace_id
      LEFT JOIN entities e
        ON e.id = sd.entity_id
        AND e.workspace_id = sd.workspace_id
      ${fileFieldJoin}
      WHERE sd.organization_id = ${organizationId}
        ${entityWorkspaceFilter}
        ${entityTypeFilter}
        ${entityEditorFilter}
        ${entityMimeFilter}
        ${entityUpdatedFilter}
        AND sd.tsv @@ ${tsQuery}
    `
    : emptyWorkspaceFacetQuery;

  const matterWorkspaceFacetQuery =
    !restrictToEntities && shouldSearchType(selected, "matter")
      ? sql`
      SELECT wsd.workspace_id AS value, wsd.title AS label
      FROM workspace_search_documents wsd
      WHERE wsd.organization_id = ${organizationId}
        ${matterWorkspaceFilter}
        ${matterUpdatedFilter}
        AND wsd.tsv @@ ${tsQuery}
    `
      : emptyWorkspaceFacetQuery;

  const workspaceFacetPromise = rowsWhen(
    hasSelectedEntityType(selected) || shouldSearchType(selected, "matter"),
    () =>
      db.execute(sql`
        SELECT value, label, count(*)::int AS count
        FROM (
          ${entityWorkspaceFacetQuery}
          UNION ALL
          ${matterWorkspaceFacetQuery}
        ) hits
        GROUP BY value, label
        ORDER BY count DESC, value ASC
        LIMIT ${GLOBAL_SEARCH_FACET_LIMIT}
      `),
  );

  const editorFacetPromise = rowsWhen(hasSelectedEntityType(selected), () =>
    db.execute(sql`
      SELECT editor.id AS value, editor.name AS label, count(*)::int AS count
      FROM search_documents sd
      LEFT JOIN entities e
        ON e.id = sd.entity_id
        AND e.workspace_id = sd.workspace_id
      JOIN "user" editor ON editor.id = e.last_edited_by
      ${fileFieldJoin}
      WHERE sd.organization_id = ${organizationId}
        ${entityWorkspaceFilter}
        ${entityTypeFilter}
        ${entityEditorFilter}
        ${entityMimeFilter}
        ${entityUpdatedFilter}
        AND sd.tsv @@ ${tsQuery}
      GROUP BY editor.id, editor.name
      ORDER BY count DESC, editor.name ASC
      LIMIT ${GLOBAL_SEARCH_FACET_LIMIT}
    `),
  );

  const mimeTypeFacetPromise = rowsWhen(hasSelectedEntityType(selected), () =>
    db.execute(sql`
      SELECT mime_type.value AS value, mime_type.value AS label, count(*)::int AS count
      FROM search_documents sd
      LEFT JOIN entities e
        ON e.id = sd.entity_id
        AND e.workspace_id = sd.workspace_id
      ${fileFieldJoin}
      CROSS JOIN LATERAL unnest(
        coalesce(file_field.mime_types, ARRAY[]::text[])
      ) AS mime_type(value)
      WHERE sd.organization_id = ${organizationId}
        ${entityWorkspaceFilter}
        ${entityTypeFilter}
        ${entityEditorFilter}
        ${entityMimeFilter}
        ${entityUpdatedFilter}
        AND sd.tsv @@ ${tsQuery}
      GROUP BY mime_type.value
      ORDER BY count DESC, mime_type.value ASC
      LIMIT ${GLOBAL_SEARCH_FACET_LIMIT}
    `),
  );

  const [
    entityRows,
    matterRows,
    contactRows,
    caseLawRows,
    entityCount,
    matterCount,
    contactCount,
    caseLawCount,
    entityTypeFacetRows,
    matterTypeFacetCount,
    contactTypeFacetCount,
    caseLawTypeFacetCount,
    workspaceFacetRows,
    editorFacetRows,
    mimeTypeFacetRows,
  ] = await Promise.all([
    entityPromise,
    matterPromise,
    contactPromise,
    caseLawPromise,
    ...countPromises,
    entityTypeFacetPromise,
    matterTypeFacetCountPromise,
    contactTypeFacetCountPromise,
    caseLawTypeFacetCountPromise,
    workspaceFacetPromise,
    editorFacetPromise,
    mimeTypeFacetPromise,
  ]);

  const scoredHits = [
    ...entityRows.map(mapEntityHit),
    ...matterRows.map(mapMatterHit),
    ...contactRows.map(mapContactHit),
    ...caseLawRows.map(mapCaseLawHit),
  ].sort((a, b) => b.score - a.score || b.hit.id.localeCompare(a.hit.id));

  const hits = scoredHits.slice(offset, offset + limit).map(({ hit }) => hit);
  const totalEntities = totalFrom(entityCount);
  const totalMatters = totalFrom(matterCount);
  const totalContacts = totalFrom(contactCount);
  const totalCaseLaw = totalFrom(caseLawCount);
  const totalCount =
    totalEntities + totalMatters + totalContacts + totalCaseLaw;

  const typeFacetMap = new Map<string, { count: number }>();
  for (const row of entityTypeFacetRows) {
    typeFacetMap.set(String(row["value"]), { count: Number(row["count"]) });
  }
  const matterFacetCount = totalFrom(matterTypeFacetCount);
  const contactFacetCount = totalFrom(contactTypeFacetCount);
  const caseLawFacetCount = totalFrom(caseLawTypeFacetCount);
  if (matterFacetCount > 0) {
    typeFacetMap.set("matter", { count: matterFacetCount });
  }
  if (contactFacetCount > 0) {
    typeFacetMap.set("contact", { count: contactFacetCount });
  }
  if (caseLawFacetCount > 0) {
    typeFacetMap.set("case-law", { count: caseLawFacetCount });
  }

  const workspaceFacetMap = toStringFacetMap(workspaceFacetRows);
  const editorFacetMap = toStringFacetMap(editorFacetRows);
  const mimeTypeFacetMap = toMimeTypeFacetMap(mimeTypeFacetRows);

  return {
    hits,
    facets: {
      type: facet(typeFacetMap),
      workspace: facet(workspaceFacetMap),
      editor: facet(editorFacetMap),
      mimeType: facet(mimeTypeFacetMap),
    },
    totalCount,
    nextCursor: resolveGlobalSearchNextCursor({ limit, offset, totalCount }),
  };
};

export const upsertContactSearchDocument = async (
  contactId: SafeId<"contact">,
): Promise<void> => {
  const contact = await db.query.contacts.findFirst({
    where: { id: { eq: contactId } },
    columns: {
      id: true,
      organizationId: true,
      type: true,
      prefix: true,
      firstName: true,
      middleName: true,
      lastName: true,
      suffix: true,
      organizationName: true,
      displayName: true,
      notes: true,
      emails: true,
      phones: true,
      addresses: true,
      tags: true,
      registrationNumber: true,
      taxId: true,
      currency: true,
      updatedAt: true,
    },
  });

  if (!contact) {
    return;
  }

  const searchableText = compact([
    contact.prefix,
    contact.firstName,
    contact.middleName,
    contact.lastName,
    contact.suffix,
    contact.organizationName,
    contact.notes,
    emailsToText(contact.emails),
    phonesToText(contact.phones),
    addressesToText(contact.addresses),
    tagsToText(contact.tags),
    contact.registrationNumber,
    contact.taxId,
    contact.currency,
  ]);

  await db.execute(sql`
    INSERT INTO contact_search_documents (
      contact_id, organization_id, contact_type,
      title, searchable_text, updated_at, tsv
    ) VALUES (
      ${contact.id},
      ${contact.organizationId},
      ${contact.type},
      ${contact.displayName},
      ${searchableText},
      ${contact.updatedAt},
      to_tsvector(
        'simple',
        unaccent(
          coalesce(${contact.displayName}, '') || ' ' ||
          coalesce(${searchableText}, '')
        )
      )
    )
    ON CONFLICT (contact_id) DO UPDATE SET
      organization_id = EXCLUDED.organization_id,
      contact_type = EXCLUDED.contact_type,
      title = EXCLUDED.title,
      searchable_text = EXCLUDED.searchable_text,
      updated_at = EXCLUDED.updated_at,
      tsv = EXCLUDED.tsv
  `);
};

export const upsertWorkspaceSearchDocument = async (
  workspaceId: SafeId<"workspace">,
): Promise<void> => {
  const workspace = await db.query.workspaces.findFirst({
    where: { id: { eq: workspaceId } },
    columns: {
      id: true,
      organizationId: true,
      name: true,
      reference: true,
      billingReference: true,
      lastActivityAt: true,
      createdAt: true,
    },
    with: {
      client: {
        columns: {
          displayName: true,
          organizationName: true,
          firstName: true,
          lastName: true,
          emails: true,
          phones: true,
          tags: true,
          updatedAt: true,
        },
      },
      workspaceContacts: {
        columns: {
          role: true,
          notes: true,
        },
        with: {
          contact: {
            columns: {
              displayName: true,
              organizationName: true,
              firstName: true,
              lastName: true,
              emails: true,
              phones: true,
              tags: true,
              updatedAt: true,
            },
          },
        },
      },
    },
  });

  if (!workspace) {
    return;
  }

  const client = workspace.client;
  const partyText = workspace.workspaceContacts.map(
    ({ role, notes, contact }) =>
      compact([
        role,
        notes,
        contact?.displayName,
        contact?.organizationName,
        contact?.firstName,
        contact?.lastName,
        emailsToText(contact?.emails),
        phonesToText(contact?.phones),
        tagsToText(contact?.tags),
      ]),
  );

  const searchableText = compact([
    workspace.reference,
    workspace.billingReference,
    client?.displayName,
    client?.organizationName,
    client?.firstName,
    client?.lastName,
    emailsToText(client?.emails),
    phonesToText(client?.phones),
    tagsToText(client?.tags),
    ...partyText,
  ]);
  const updatedAt =
    latestDate([
      workspace.createdAt,
      workspace.lastActivityAt,
      client?.updatedAt,
      ...workspace.workspaceContacts.map(({ contact }) => contact?.updatedAt),
    ]) ?? workspace.lastActivityAt;

  await db.execute(sql`
    INSERT INTO workspace_search_documents (
      workspace_id, organization_id,
      title, searchable_text, updated_at, tsv
    ) VALUES (
      ${workspace.id},
      ${workspace.organizationId},
      ${workspace.name},
      ${searchableText},
      ${updatedAt},
      to_tsvector(
        'simple',
        unaccent(
          coalesce(${workspace.name}, '') || ' ' ||
          coalesce(${searchableText}, '')
        )
      )
    )
    ON CONFLICT (workspace_id) DO UPDATE SET
      organization_id = EXCLUDED.organization_id,
      title = EXCLUDED.title,
      searchable_text = EXCLUDED.searchable_text,
      updated_at = EXCLUDED.updated_at,
      tsv = EXCLUDED.tsv
  `);
};

export const syncWorkspaceSearchActivity = async (
  workspaceId: SafeId<"workspace">,
): Promise<void> => {
  await db.execute(sql`
    UPDATE workspace_search_documents wsd
    SET updated_at = w.last_activity_at
    FROM workspaces w
    WHERE w.id = ${workspaceId}
      AND wsd.workspace_id = w.id
      AND wsd.updated_at < w.last_activity_at
  `);
};

export const upsertWorkspaceSearchDocuments = async (
  workspaceIds: readonly SafeId<"workspace">[],
): Promise<void> => {
  const pending = [...new Set(workspaceIds)];
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(WORKSPACE_REINDEX_CONCURRENCY, pending.length);

  for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
    workers.push(
      (async () => {
        while (pending.length > 0) {
          const workspaceId = pending.shift();
          if (!workspaceId) {
            return;
          }
          await upsertWorkspaceSearchDocument(workspaceId);
        }
      })(),
    );
  }

  await Promise.all(workers);
};

export const reindexWorkspacesForContact = async (
  contactId: SafeId<"contact">,
): Promise<void> => {
  const contact = await db.query.contacts.findFirst({
    where: { id: { eq: contactId } },
    columns: { organizationId: true },
  });

  if (!contact) {
    return;
  }

  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .leftJoin(
      workspaceContacts,
      eq(workspaceContacts.workspaceId, workspaces.id),
    )
    .where(
      and(
        eq(workspaces.organizationId, contact.organizationId),
        or(
          eq(workspaces.clientId, contactId),
          eq(workspaceContacts.contactId, contactId),
        ),
      ),
    )
    .groupBy(workspaces.id);

  await upsertWorkspaceSearchDocuments(rows.map(({ id }) => id));
};

export const rebuildSupplementalSearchIndex = async (
  organizationId: SafeId<"organization">,
): Promise<void> => {
  let lastContactId: SafeId<"contact"> | null = null;
  let hasMoreContacts = true;

  while (hasMoreContacts) {
    const batch = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        lastContactId
          ? and(
              eq(contacts.organizationId, organizationId),
              gt(contacts.id, lastContactId),
            )
          : eq(contacts.organizationId, organizationId),
      )
      .orderBy(asc(contacts.id))
      .limit(REINDEX_BATCH_SIZE);

    for (const contact of batch) {
      await upsertContactSearchDocument(contact.id);
    }

    hasMoreContacts = batch.length === REINDEX_BATCH_SIZE;
    lastContactId = batch.at(-1)?.id ?? lastContactId;
  }

  let lastWorkspaceId: SafeId<"workspace"> | null = null;
  let hasMoreWorkspaces = true;

  while (hasMoreWorkspaces) {
    const batch = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        lastWorkspaceId
          ? and(
              eq(workspaces.organizationId, organizationId),
              gt(workspaces.id, lastWorkspaceId),
            )
          : eq(workspaces.organizationId, organizationId),
      )
      .orderBy(asc(workspaces.id))
      .limit(REINDEX_BATCH_SIZE);

    for (const workspace of batch) {
      await upsertWorkspaceSearchDocument(workspace.id);
    }

    hasMoreWorkspaces = batch.length === REINDEX_BATCH_SIZE;
    lastWorkspaceId = batch.at(-1)?.id ?? lastWorkspaceId;
  }
};
