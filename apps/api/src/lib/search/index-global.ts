import { panic } from "better-result";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { isEntityKind, resourceRef, RESOURCE_TYPE } from "@stll/api-contract";
import { compareCodeUnit } from "@stll/collation";

import { rootDb } from "@/api/db/root";
import { contacts, workspaceContacts, workspaces } from "@/api/db/schema";
import type {
  ContactAddress,
  ContactEmail,
  ContactPhone,
} from "@/api/db/schema-validators";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { decisionIdentifierProjection } from "@/api/lib/case-law/decision-identifiers";
import { redistributableSourceJoin } from "@/api/lib/case-law/search-sql";
import { LIMITS } from "@/api/lib/limits";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedChatThreadId,
  brandPersistedContactId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { CHAT_SEARCH_DISPLAY_METADATA_GENERATION } from "@/api/lib/search/chat-search-generation";
import { chatThreadScopeSql } from "@/api/lib/search/chat-thread-scope-sql";
import {
  contactWorkspaceAccessSql,
  searchDocumentsAccessSql,
  workspaceSearchDocumentsAccessSql,
} from "@/api/lib/search/contact-workspace-access-sql";
import { mapEntityHit } from "@/api/lib/search/global-search-mappers";
import {
  escapeAndHighlight,
  TS_HEADLINE_CONFIG,
} from "@/api/lib/search/highlight";
import {
  compareScoredSearchHits,
  GLOBAL_SEARCH_RESULT_LIMIT,
  globalSearchCursorSql,
  paginateScoredSearchHits,
  parseGlobalSearchCursor,
} from "@/api/lib/search/pagination";
import {
  buildSearchPreviewPassages,
  buildSearchPreviewPassageValueRows,
} from "@/api/lib/search/preview-passages";
import { buildSearchTsQuery } from "@/api/lib/search/query";
import { globalSearchIdentity } from "@/api/lib/search/resource-search";
import { typedPgArray } from "@/api/lib/search/sql";
import type {
  ChatGlobalSearchHit,
  ContactGlobalSearchHit,
  FacetBucket,
  GlobalSearchHit,
  GlobalSearchResult,
  GlobalSearchResultType,
  MatterGlobalSearchHit,
} from "@/api/lib/search/types";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

const REINDEX_BATCH_SIZE = 100;
const WORKSPACE_REINDEX_CONCURRENCY = 4;
const GLOBAL_SEARCH_FACET_LIMIT = 20;
const MATTER_RELEVANCE_BOOST = 0.15;

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
  /** The calling user. Chat threads are private per user, so the chat
   *  source filters on this; the workspace-shared sources ignore it. */
  userId: SafeId<"user">;
  /** All workspaces the caller is allowed to see. */
  accessibleWorkspaceIds: readonly SafeId<"workspace">[];
  /** User-selected subset to filter by; empty means no extra filter. */
  selectedWorkspaceIds: readonly SafeId<"workspace">[];
  types: readonly GlobalSearchResultType[];
  editedByUserIds: readonly string[];
  mimeTypes: readonly string[];
  updatedFrom?: string | undefined;
  updatedTo?: string | undefined;
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
  compact(
    emails === null || emails === undefined
      ? []
      : emails.flatMap((email) => [email.address, email.label]),
  );

const phonesToText = (phones: readonly ContactPhone[] | null | undefined) =>
  compact(
    phones === null || phones === undefined
      ? []
      : phones.flatMap((phone) => [phone.number, phone.label]),
  );

const addressesToText = (
  addresses: readonly ContactAddress[] | null | undefined,
) =>
  compact(
    addresses === null || addresses === undefined
      ? []
      : addresses.flatMap((address) => [
          address.line1,
          address.line2,
          address.city,
          address.state,
          address.postalCode,
          address.country,
          address.label,
        ]),
  );

const tagsToText = (tags: readonly string[] | null | undefined) =>
  compact(arrayOrEmpty(tags));

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

const selectedTypes = (types: readonly GlobalSearchResultType[]) =>
  new Set<GlobalSearchResultType>(types);

const shouldSearchType = (
  selected: ReadonlySet<GlobalSearchResultType>,
  type: GlobalSearchResultType,
) => selected.size === 0 || selected.has(type);

const NATIVE_PREVIEW_MIME_TYPES = [PDF_MIME_TYPE, DOCX_MIME_TYPE] as const;

const hasSelectedEntityType = (selected: ReadonlySet<GlobalSearchResultType>) =>
  selected.size === 0 || [...selected].some(isEntityKind);

const fileFieldJoin = (mimeTypes: readonly string[]) => {
  const mimeFilter =
    mimeTypes.length > 0
      ? sql`AND files.mime_type = ANY(${typedPgArray(mimeTypes, "text")})`
      : sql``;

  return sql`
  LEFT JOIN LATERAL (
    WITH files AS (
      SELECT
        f.id AS field_id,
        f.property_id,
        field_content.content ->> 'mimeType' AS mime_type,
        EXISTS (
          SELECT 1
          FROM extracted_content ec
          WHERE ec.entity_id = sd.entity_id
            AND ec.organization_id = sd.organization_id
            AND ec.workspace_id = sd.workspace_id
            AND ec.source_entity_version_id = e.current_version_id
            AND ec.source_field_id = f.id
        ) AS is_extracted_source
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
    )
    SELECT
      files.field_id,
      files.property_id,
      files.mime_type,
      (
        SELECT array_agg(DISTINCT available.mime_type ORDER BY available.mime_type)
        FROM files available
      ) AS mime_types
    FROM files
    WHERE TRUE
      ${mimeFilter}
    ORDER BY
      files.is_extracted_source DESC,
      (files.mime_type = ANY(${typedPgArray(NATIVE_PREVIEW_MIME_TYPES, "text")})) DESC,
      files.field_id ASC
    LIMIT 1
  ) file_field ON true
`;
};

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

const mapMatterHit = (row: RawRow): ScoredGlobalSearchHit => {
  const workspaceId = String(row["id"]);
  const resource = resourceRef({
    type: RESOURCE_TYPE.WORKSPACE,
    id: brandPersistedWorkspaceId(workspaceId),
  });
  const hit: MatterGlobalSearchHit = {
    ...globalSearchIdentity(resource),
    id: `matter:${workspaceId}`,
    type: "matter",
    workspaceId,
    workspaceName: String(row["title"]),
    title: String(row["title"]),
    headline: toHeadline(row["headline"]),
    updatedAt: toIso(row["updated_at"]),
    color: toNullableString(row["color"]),
  };

  return { hit, score: Number(row["score"]) };
};

const mapContactHit = (row: RawRow): ScoredGlobalSearchHit => {
  const contactId = String(row["id"]);
  const contactType = String(row["contact_type"]);
  const resource = resourceRef({
    type: RESOURCE_TYPE.CONTACT,
    id: brandPersistedContactId(contactId),
  });
  const hit: ContactGlobalSearchHit = {
    ...globalSearchIdentity(resource),
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
  const resource = resourceRef({
    type: RESOURCE_TYPE.CASE_LAW_DECISION,
    id: brandPersistedCaseLawDecisionId(decisionId),
  });
  const hit: GlobalSearchHit = {
    ...globalSearchIdentity(resource),
    id: `case-law:${decisionId}`,
    type: "case-law",
    decisionId,
    caseNumber: String(row["case_number"]),
    identifiers: decisionIdentifierProjection(row["identifiers"], {
      caseNumber: String(row["case_number"]),
      ecli: toNullableString(row["ecli"]),
    }),
    court: String(row["court"]),
    country: String(row["country"]),
    decisionDate: toNullableString(row["decision_date"]),
    title: `${String(row["case_number"])} - ${String(row["court"])}`,
    headline: toHeadline(row["headline"]),
    updatedAt: toIso(row["updated_at"]),
  };

  return { hit, score: Number(row["score"]) };
};

const mapChatHit = (row: RawRow): ScoredGlobalSearchHit => {
  const threadId = String(row["id"]);
  const resource = resourceRef({
    type: RESOURCE_TYPE.CHAT_THREAD,
    id: brandPersistedChatThreadId(threadId),
  });
  const hit: ChatGlobalSearchHit = {
    ...globalSearchIdentity(resource),
    id: `chat:${threadId}`,
    type: "chat",
    threadId,
    workspaceId: toNullableString(row["workspace_id"]),
    workspaceName: toNullableString(row["workspace_name"]),
    title: String(row["title"]),
    headline: toHeadline(row["headline"]),
    updatedAt: toIso(row["updated_at"]),
  };

  return { hit, score: Number(row["score"]) };
};

const facetBuckets = (
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
    // facet value is a raw filter key (id/enum), a count tiebreak, not display text
    .sort((a, b) => b.count - a.count || compareCodeUnit(a.value, b.value));

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

export { contactWorkspaceAccessSql };

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

type FilterFragmentInput = {
  query: string;
  types: readonly GlobalSearchResultType[];
  editedByUserIds: readonly string[];
  mimeTypes: readonly string[];
  updatedFrom?: string | undefined;
  updatedTo?: string | undefined;
};

/**
 * Build the SQL fragments shared by all global-search code paths
 * (the main hit/count/facet queries and per-facet bucket lookup).
 *
 * Each call site picks the fragments it needs and embeds them in
 * its own outer query — the helper itself runs no SQL.
 */
const buildSearchFilterFragments = ({
  query,
  types,
  editedByUserIds,
  mimeTypes,
  updatedFrom,
  updatedTo,
}: FilterFragmentInput) => {
  const selected = selectedTypes(types);
  const hasEditorFilter = editedByUserIds.length > 0;
  const hasMimeTypeFilter = mimeTypes.length > 0;
  const hasSearchQuery = query.trim().length > 0;
  const restrictToEntities = hasEditorFilter || hasMimeTypeFilter;
  const tsQuery = buildSearchTsQuery(query);
  const normalizedUpdatedFrom =
    updatedFrom === undefined ? undefined : new Date(updatedFrom).toISOString();
  const normalizedUpdatedTo =
    updatedTo === undefined ? undefined : new Date(updatedTo).toISOString();

  const entityTypes = [...selected].filter(isEntityKind);
  const entityEditorFilter = sqlWhen(
    hasEditorFilter,
    () =>
      sql`AND e.last_edited_by = ANY(${typedPgArray(editedByUserIds, "text")})`,
  );
  const entityMimeFilter = sqlWhen(
    hasMimeTypeFilter,
    () => sql`AND file_field.field_id IS NOT NULL`,
  );
  const updatedRangeFilter = (column: SQL): SQL => {
    const fragments: SQL[] = [];
    if (normalizedUpdatedFrom !== undefined) {
      fragments.push(sql`AND ${column} >= ${normalizedUpdatedFrom}`);
    }
    if (normalizedUpdatedTo !== undefined) {
      fragments.push(sql`AND ${column} <= ${normalizedUpdatedTo}`);
    }
    return fragments.length > 0 ? sql.join(fragments, sql` `) : sql``;
  };
  const entityUpdatedFilter = updatedRangeFilter(sql`sd.updated_at`);
  const matterUpdatedFilter = updatedRangeFilter(sql`wsd.updated_at`);
  const contactUpdatedFilter = updatedRangeFilter(sql`csd.updated_at`);
  const caseLawUpdatedFilter = updatedRangeFilter(sql`d.updated_at`);
  const chatUpdatedFilter = updatedRangeFilter(sql`t.updated_at`);
  const entityTextSearchFilter = sqlWhen(
    hasSearchQuery,
    () => sql`AND sd.tsv @@ ${tsQuery}`,
  );
  const matterTextSearchFilter = sqlWhen(
    hasSearchQuery,
    () => sql`AND wsd.tsv @@ ${tsQuery}`,
  );
  const contactTextSearchFilter = sqlWhen(
    hasSearchQuery,
    () => sql`AND csd.tsv @@ ${tsQuery}`,
  );
  const caseLawTextSearchFilter = sqlWhen(
    hasSearchQuery,
    () => sql`AND clsd.tsv @@ ${tsQuery}`,
  );
  const chatTextSearchFilter = sqlWhen(
    hasSearchQuery,
    () => sql`AND cst.tsv @@ ${tsQuery}`,
  );
  // The truncation belongs here, not at the call sites: `ts_headline` cost
  // grows with the document it is handed, and a per-branch `left(...)` is a
  // bound each new branch has to remember. Snippets come from the head of the
  // text either way.
  const searchHeadline = (document: SQL): SQL =>
    hasSearchQuery
      ? sql`ts_headline(
          ${headlineRegconfig},
          left(${document}, ${LIMITS.searchHeadlineDocumentMaxChars}),
          ${tsQuery},
          ${TS_HEADLINE_CONFIG}
        ) AS headline`
      : sql`NULL::text AS headline`;
  const searchScoreValue = ({
    tsv,
    updatedAt,
    relevanceBoost,
  }: {
    tsv: SQL;
    updatedAt: SQL;
    relevanceBoost?: number | undefined;
  }): SQL => {
    if (!hasSearchQuery) {
      return sql`extract(epoch from ${updatedAt})::float8 * 1000`;
    }
    if (relevanceBoost === undefined) {
      return sql`ts_rank(${tsv}, ${tsQuery})::float8`;
    }
    return sql`ts_rank(${tsv}, ${tsQuery})::float8 + ${relevanceBoost}::float8`;
  };
  const searchScore = (options: {
    tsv: SQL;
    updatedAt: SQL;
    relevanceBoost?: number | undefined;
  }): SQL => sql`${searchScoreValue(options)} AS score`;
  const searchOrderBy = ({
    id,
    updatedAt,
  }: {
    id: SQL;
    updatedAt: SQL;
  }): SQL =>
    hasSearchQuery
      ? sql`score DESC, ${id} DESC`
      : sql`${updatedAt} DESC, ${id} DESC`;
  const entityTypeFilter = sqlWhen(
    selected.size > 0,
    () => sql`AND sd.kind = ANY(${typedPgArray(entityTypes, "text")})`,
  );
  const entityTypeFacetFilter =
    selected.size > 0 && !hasSearchQuery && normalizedUpdatedFrom === undefined
      ? entityTypeFilter
      : sql``;

  return {
    selected,
    hasEditorFilter,
    hasMimeTypeFilter,
    restrictToEntities,
    tsQuery,
    entityEditorFilter,
    entityMimeFilter,
    entityUpdatedFilter,
    matterUpdatedFilter,
    contactUpdatedFilter,
    caseLawUpdatedFilter,
    chatUpdatedFilter,
    entityTextSearchFilter,
    matterTextSearchFilter,
    contactTextSearchFilter,
    caseLawTextSearchFilter,
    chatTextSearchFilter,
    searchHeadline,
    searchScore,
    searchScoreValue,
    searchOrderBy,
    hasSearchQuery,
    entityTypeFilter,
    entityTypeFacetFilter,
  };
};

export const searchGlobal = async (
  {
    query,
    organizationId,
    userId,
    accessibleWorkspaceIds,
    selectedWorkspaceIds,
    types,
    editedByUserIds,
    mimeTypes,
    updatedFrom,
    updatedTo,
    cursor,
    limit,
  }: GlobalSearchQuery,
  database: Pick<typeof rootDb, "execute"> = rootDb,
): Promise<GlobalSearchResult> => {
  const parsedCursor = parseGlobalSearchCursor(cursor);
  const pagination = (() => {
    switch (parsedCursor.type) {
      case "initial":
        return {
          isFirstPage: true,
          legacyOffset: null,
          searchCursor: null,
          seen: 0,
        };
      case "keyset":
        return {
          isFirstPage: false,
          legacyOffset: null,
          searchCursor: parsedCursor.cursor,
          seen: parsedCursor.cursor.seen,
        };
      case "legacy":
        return {
          isFirstPage: false,
          legacyOffset: parsedCursor.offset,
          searchCursor: null,
          seen: parsedCursor.offset,
        };
      case "invalid":
        return panic("searchGlobal received an invalid cursor");
      default: {
        parsedCursor satisfies never;
        return panic(`Unhandled parsed cursor: ${String(parsedCursor)}`);
      }
    }
  })();
  const { isFirstPage, legacyOffset, searchCursor, seen } = pagination;
  const pageLimit = Math.min(limit, GLOBAL_SEARCH_RESULT_LIMIT - seen);
  const fetchLimit = (legacyOffset ?? 0) + pageLimit + 1;
  // Counts and facets are computed only on the first page. Subsequent
  // pages reuse the values the client already has, saving ~7 of the
  // 15 SQL round-trips per request.
  const {
    selected,
    restrictToEntities,
    entityEditorFilter,
    entityMimeFilter,
    entityUpdatedFilter,
    matterUpdatedFilter,
    contactUpdatedFilter,
    caseLawUpdatedFilter,
    chatUpdatedFilter,
    entityTextSearchFilter,
    matterTextSearchFilter,
    contactTextSearchFilter,
    caseLawTextSearchFilter,
    chatTextSearchFilter,
    searchHeadline,
    searchScore,
    searchScoreValue,
    searchOrderBy,
    hasSearchQuery,
    entityTypeFilter,
    entityTypeFacetFilter,
  } = buildSearchFilterFragments({
    query,
    types,
    editedByUserIds,
    mimeTypes,
    updatedFrom,
    updatedTo,
  });
  const entityWorkspaceFilter = searchDocumentsAccessSql({
    accessibleWorkspaceIds,
    selectedWorkspaceIds,
  });
  const entityWorkspaceFacetFilter = searchDocumentsAccessSql({
    accessibleWorkspaceIds,
    selectedWorkspaceIds: [],
  });
  const selectedFileFieldJoin = fileFieldJoin(mimeTypes);
  const allFileFieldJoin = fileFieldJoin([]);
  const matterWorkspaceFilter = workspaceSearchDocumentsAccessSql({
    accessibleWorkspaceIds,
    selectedWorkspaceIds,
  });
  const matterWorkspaceFacetFilter = workspaceSearchDocumentsAccessSql({
    accessibleWorkspaceIds,
    selectedWorkspaceIds: [],
  });
  const contactWorkspaceFilter = contactWorkspaceAccessSql({
    organizationId,
    accessibleWorkspaceIds,
    selectedWorkspaceIds,
  });

  const entityPromise = rowsWhen(hasSelectedEntityType(selected), () =>
    database.execute(sql`
      SELECT
        sd.entity_id AS id,
        sd.workspace_id,
        w.name AS workspace_name,
        sd.kind AS type,
        sd.title,
        e.parent_id,
        editor.name AS last_edited_by_name,
        editor.image AS last_edited_by_image,
        file_field.field_id AS file_field_id,
        file_field.property_id AS file_property_id,
        file_field.mime_type,
        ${searchHeadline(sql`sd.title || ' ' || sd.searchable_text`)},
        ${searchScore({ tsv: sql`sd.tsv`, updatedAt: sql`sd.updated_at` })},
        sd.updated_at
      FROM search_documents sd
      JOIN workspaces w ON w.id = sd.workspace_id
      LEFT JOIN entities e
        ON e.id = sd.entity_id
        AND e.workspace_id = sd.workspace_id
      LEFT JOIN "user" editor ON editor.id = e.last_edited_by
      ${selectedFileFieldJoin}
      WHERE sd.organization_id = ${organizationId}
        ${entityTypeFilter}
        ${entityEditorFilter}
        ${entityMimeFilter}
        ${entityUpdatedFilter}
        ${entityTextSearchFilter}
        ${entityWorkspaceFilter}
        ${globalSearchCursorSql({
          cursor: searchCursor,
          score: searchScoreValue({
            tsv: sql`sd.tsv`,
            updatedAt: sql`sd.updated_at`,
          }),
          id: sql`'entity:' || sd.entity_id::text`,
        })}
      ORDER BY ${searchOrderBy({ id: sql`sd.entity_id`, updatedAt: sql`sd.updated_at` })}
      LIMIT ${fetchLimit}
    `),
  );

  const matterPromise = rowsWhen(
    !restrictToEntities && shouldSearchType(selected, "matter"),
    () =>
      database.execute(sql`
      SELECT
        wsd.workspace_id AS id,
        wsd.title,
        w.color,
        ${searchHeadline(sql`wsd.title || ' ' || wsd.searchable_text`)},
        ${searchScore({
          tsv: sql`wsd.tsv`,
          updatedAt: sql`wsd.updated_at`,
          relevanceBoost: MATTER_RELEVANCE_BOOST,
        })},
        wsd.updated_at
      FROM workspace_search_documents wsd
      JOIN workspaces w ON w.id = wsd.workspace_id
      WHERE wsd.organization_id = ${organizationId}
        ${matterUpdatedFilter}
        ${matterTextSearchFilter}
        ${matterWorkspaceFilter}
        ${globalSearchCursorSql({
          cursor: searchCursor,
          score: searchScoreValue({
            tsv: sql`wsd.tsv`,
            updatedAt: sql`wsd.updated_at`,
            relevanceBoost: MATTER_RELEVANCE_BOOST,
          }),
          id: sql`'matter:' || wsd.workspace_id::text`,
        })}
      ORDER BY ${searchOrderBy({ id: sql`wsd.workspace_id`, updatedAt: sql`wsd.updated_at` })}
      LIMIT ${fetchLimit}
    `),
  );

  const contactPromise = rowsWhen(
    !restrictToEntities &&
      accessibleWorkspaceIds.length > 0 &&
      shouldSearchType(selected, "contact"),
    () =>
      database.execute(sql`
      SELECT
        csd.contact_id AS id,
        csd.contact_type,
        csd.title,
        ${searchHeadline(sql`csd.title || ' ' || csd.searchable_text`)},
        ${searchScore({ tsv: sql`csd.tsv`, updatedAt: sql`csd.updated_at` })},
        csd.updated_at
      FROM contact_search_documents csd
      WHERE csd.organization_id = ${organizationId}
        ${contactUpdatedFilter}
        ${contactTextSearchFilter}
        ${contactWorkspaceFilter}
        ${globalSearchCursorSql({
          cursor: searchCursor,
          score: searchScoreValue({
            tsv: sql`csd.tsv`,
            updatedAt: sql`csd.updated_at`,
          }),
          id: sql`'contact:' || csd.contact_id::text`,
        })}
      ORDER BY ${searchOrderBy({ id: sql`csd.contact_id`, updatedAt: sql`csd.updated_at` })}
      LIMIT ${fetchLimit}
    `),
  );

  const caseLawPromise = rowsWhen(
    !restrictToEntities && shouldSearchType(selected, "case-law"),
    () =>
      database.execute(sql`
      SELECT
        clsd.decision_id AS id,
        d.case_number,
        d.ecli,
        d.court,
        d.country,
        d.decision_date,
        (
          SELECT coalesce(
            jsonb_agg(
              jsonb_build_object('type', identifier.type, 'value', identifier.value)
              ORDER BY identifier.type, identifier.value
            ),
            '[]'::jsonb
          )
          FROM case_law_decision_identifiers identifier
          WHERE identifier.decision_id = d.id
        ) AS identifiers,
        ${searchHeadline(sql`coalesce(nullif(body_preview.text, ''), d.fulltext, clsd.searchable_text)`)},
        ${searchScore({ tsv: sql`clsd.tsv`, updatedAt: sql`d.updated_at` })},
        d.updated_at
      FROM case_law_search_documents clsd
      JOIN case_law_decisions d ON d.id = clsd.decision_id
      ${redistributableSourceJoin}
      ${caseLawBodyPreviewJoin}
      WHERE TRUE
        ${caseLawTextSearchFilter}
        ${caseLawUpdatedFilter}
        ${globalSearchCursorSql({
          cursor: searchCursor,
          score: searchScoreValue({
            tsv: sql`clsd.tsv`,
            updatedAt: sql`d.updated_at`,
          }),
          id: sql`'case-law:' || clsd.decision_id::text`,
        })}
      ORDER BY ${searchOrderBy({ id: sql`clsd.decision_id`, updatedAt: sql`d.updated_at` })}
      LIMIT ${fetchLimit}
    `),
  );

  const chatScope = chatThreadScopeSql({
    userId,
    organizationId,
    accessibleWorkspaceIds,
    selectedWorkspaceIds,
  });

  const chatPromise = rowsWhen(
    !restrictToEntities && shouldSearchType(selected, "chat"),
    () =>
      database.execute(sql`
      SELECT
        t.id AS id,
        t.workspace_id,
        w.name AS workspace_name,
        cst.title,
        ${searchHeadline(sql`cst.title || ' ' || cst.searchable_text`)},
        ${searchScore({ tsv: sql`cst.tsv`, updatedAt: sql`t.updated_at` })},
        t.updated_at
      FROM chat_thread_search_documents cst
      JOIN chat_threads t ON t.id = cst.thread_id
      LEFT JOIN workspaces w ON w.id = t.workspace_id
      WHERE TRUE
        AND ${chatScope}
        AND cst.preview_generation =
          ${CHAT_SEARCH_DISPLAY_METADATA_GENERATION}::uuid
        ${chatUpdatedFilter}
        ${chatTextSearchFilter}
        ${globalSearchCursorSql({
          cursor: searchCursor,
          score: searchScoreValue({
            tsv: sql`cst.tsv`,
            updatedAt: sql`t.updated_at`,
          }),
          id: sql`'chat:' || cst.thread_id::text`,
        })}
      ORDER BY ${searchOrderBy({ id: sql`t.id`, updatedAt: sql`t.updated_at` })}
      LIMIT ${fetchLimit}
    `),
  );

  const hasAlternativeFacetPredicate =
    hasSearchQuery || updatedFrom !== undefined;
  const caseLawCountQuery = sql`
    SELECT count(*)::int AS total
    FROM (
      SELECT 1
      FROM case_law_search_documents clsd
      JOIN case_law_decisions d ON d.id = clsd.decision_id
      ${redistributableSourceJoin}
      WHERE TRUE
        ${caseLawTextSearchFilter}
        ${caseLawUpdatedFilter}
      LIMIT ${GLOBAL_SEARCH_RESULT_LIMIT}
    ) bounded_case_law
  `;

  const countPromises = [
    countWhen(isFirstPage && hasSelectedEntityType(selected), () =>
      database.execute(sql`
        SELECT count(*)::int AS total
        FROM search_documents sd
        LEFT JOIN entities e
          ON e.id = sd.entity_id
          AND e.workspace_id = sd.workspace_id
        ${selectedFileFieldJoin}
        WHERE sd.organization_id = ${organizationId}
          ${entityTypeFilter}
          ${entityEditorFilter}
          ${entityMimeFilter}
          ${entityUpdatedFilter}
          ${entityTextSearchFilter}
          ${entityWorkspaceFilter}
      `),
    ),
    countWhen(
      isFirstPage &&
        !restrictToEntities &&
        shouldSearchType(selected, "matter"),
      () =>
        database.execute(sql`
        SELECT count(*)::int AS total
        FROM workspace_search_documents wsd
        WHERE wsd.organization_id = ${organizationId}
          ${matterUpdatedFilter}
          ${matterTextSearchFilter}
          ${matterWorkspaceFilter}
      `),
    ),
    countWhen(
      isFirstPage &&
        !restrictToEntities &&
        accessibleWorkspaceIds.length > 0 &&
        shouldSearchType(selected, "contact"),
      () =>
        database.execute(sql`
        SELECT count(*)::int AS total
        FROM contact_search_documents csd
        WHERE csd.organization_id = ${organizationId}
          ${contactUpdatedFilter}
          ${contactTextSearchFilter}
          ${contactWorkspaceFilter}
      `),
    ),
    countWhen(
      isFirstPage &&
        !restrictToEntities &&
        shouldSearchType(selected, "case-law"),
      () => database.execute(caseLawCountQuery),
    ),
    countWhen(
      isFirstPage && !restrictToEntities && shouldSearchType(selected, "chat"),
      () =>
        database.execute(sql`
        SELECT count(*)::int AS total
        FROM chat_thread_search_documents cst
        JOIN chat_threads t ON t.id = cst.thread_id
        WHERE TRUE
          AND ${chatScope}
          AND cst.preview_generation =
            ${CHAT_SEARCH_DISPLAY_METADATA_GENERATION}::uuid
          ${chatUpdatedFilter}
          ${chatTextSearchFilter}
      `),
    ),
  ] as const;

  const entityTypeFacetPromise = rowsWhen(
    isFirstPage && hasSelectedEntityType(selected),
    () =>
      database.execute(sql`
      SELECT sd.kind AS value, count(*)::int AS count
      FROM search_documents sd
      LEFT JOIN entities e
        ON e.id = sd.entity_id
        AND e.workspace_id = sd.workspace_id
      ${selectedFileFieldJoin}
      WHERE sd.organization_id = ${organizationId}
        ${entityTypeFacetFilter}
        ${entityEditorFilter}
        ${entityMimeFilter}
        ${entityUpdatedFilter}
        ${entityTextSearchFilter}
        ${entityWorkspaceFilter}
      GROUP BY sd.kind
      ORDER BY count DESC, sd.kind ASC
      LIMIT ${GLOBAL_SEARCH_FACET_LIMIT}
    `),
  );

  // The primary count already covers a selected type (or every type when no
  // type is selected). Only query alternative buckets for a text or lower-date
  // search, not for blank type-only or upper-bound-only browsing. Public
  // case-law counts are independently capped at the pagination horizon.
  const shouldCountAlternativeTypeFacet = (
    type: GlobalSearchResultType,
  ): boolean =>
    isFirstPage &&
    !restrictToEntities &&
    !shouldSearchType(selected, type) &&
    hasAlternativeFacetPredicate;

  const matterTypeFacetCountPromise = countWhen(
    shouldCountAlternativeTypeFacet("matter"),
    () =>
      database.execute(sql`
      SELECT count(*)::int AS total
      FROM workspace_search_documents wsd
      WHERE wsd.organization_id = ${organizationId}
        ${matterUpdatedFilter}
        ${matterTextSearchFilter}
        ${matterWorkspaceFilter}
    `),
  );

  const contactTypeFacetCountPromise = countWhen(
    shouldCountAlternativeTypeFacet("contact") &&
      accessibleWorkspaceIds.length > 0,
    () =>
      database.execute(sql`
        SELECT count(*)::int AS total
        FROM contact_search_documents csd
        WHERE csd.organization_id = ${organizationId}
          ${contactUpdatedFilter}
          ${contactTextSearchFilter}
          ${contactWorkspaceFilter}
      `),
  );

  const caseLawTypeFacetCountPromise = countWhen(
    shouldCountAlternativeTypeFacet("case-law"),
    () => database.execute(caseLawCountQuery),
  );

  const chatTypeFacetCountPromise = countWhen(
    shouldCountAlternativeTypeFacet("chat"),
    () =>
      database.execute(sql`
      SELECT count(*)::int AS total
      FROM chat_thread_search_documents cst
      JOIN chat_threads t ON t.id = cst.thread_id
      WHERE TRUE
        AND ${chatScope}
        AND cst.preview_generation =
          ${CHAT_SEARCH_DISPLAY_METADATA_GENERATION}::uuid
        ${chatUpdatedFilter}
        ${chatTextSearchFilter}
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
      ${selectedFileFieldJoin}
      WHERE sd.organization_id = ${organizationId}
        ${entityTypeFilter}
        ${entityEditorFilter}
        ${entityMimeFilter}
        ${entityUpdatedFilter}
        ${entityTextSearchFilter}
        ${entityWorkspaceFacetFilter}
    `
    : emptyWorkspaceFacetQuery;

  const matterWorkspaceFacetQuery =
    !restrictToEntities && shouldSearchType(selected, "matter")
      ? sql`
      SELECT wsd.workspace_id AS value, wsd.title AS label
      FROM workspace_search_documents wsd
      WHERE wsd.organization_id = ${organizationId}
        ${matterUpdatedFilter}
        ${matterTextSearchFilter}
        ${matterWorkspaceFacetFilter}
    `
      : emptyWorkspaceFacetQuery;

  const workspaceFacetPromise = rowsWhen(
    isFirstPage &&
      (hasSelectedEntityType(selected) || shouldSearchType(selected, "matter")),
    () =>
      database.execute(sql`
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

  // Editor facet drops its own filter so picking one editor still
  // shows the others as toggleable options.
  const editorFacetPromise = rowsWhen(
    isFirstPage && hasSelectedEntityType(selected),
    () =>
      database.execute(sql`
      SELECT editor.id AS value, editor.name AS label, count(*)::int AS count
      FROM search_documents sd
      LEFT JOIN entities e
        ON e.id = sd.entity_id
        AND e.workspace_id = sd.workspace_id
      JOIN "user" editor ON editor.id = e.last_edited_by
      ${selectedFileFieldJoin}
      WHERE sd.organization_id = ${organizationId}
        ${entityTypeFilter}
        ${entityMimeFilter}
        ${entityUpdatedFilter}
        ${entityTextSearchFilter}
        ${entityWorkspaceFilter}
      GROUP BY editor.id, editor.name
      ORDER BY count DESC, editor.name ASC
      LIMIT ${GLOBAL_SEARCH_FACET_LIMIT}
    `),
  );

  // Mime facet drops its own filter for the same reason.
  const mimeTypeFacetPromise = rowsWhen(
    isFirstPage && hasSelectedEntityType(selected),
    () =>
      database.execute(sql`
      SELECT mime_type.value AS value, mime_type.value AS label, count(*)::int AS count
      FROM search_documents sd
      LEFT JOIN entities e
        ON e.id = sd.entity_id
        AND e.workspace_id = sd.workspace_id
      ${allFileFieldJoin}
      CROSS JOIN LATERAL unnest(
        coalesce(file_field.mime_types, ARRAY[]::text[])
      ) AS mime_type(value)
      WHERE sd.organization_id = ${organizationId}
        ${entityTypeFilter}
        ${entityEditorFilter}
        ${entityUpdatedFilter}
        ${entityTextSearchFilter}
        ${entityWorkspaceFilter}
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
    chatRows,
    entityCount,
    matterCount,
    contactCount,
    caseLawCount,
    chatCount,
    entityTypeFacetRows,
    matterTypeFacetCount,
    contactTypeFacetCount,
    caseLawTypeFacetCount,
    chatTypeFacetCount,
    workspaceFacetRows,
    editorFacetRows,
    mimeTypeFacetRows,
  ] = await Promise.all([
    entityPromise,
    matterPromise,
    contactPromise,
    caseLawPromise,
    chatPromise,
    ...countPromises,
    entityTypeFacetPromise,
    matterTypeFacetCountPromise,
    contactTypeFacetCountPromise,
    caseLawTypeFacetCountPromise,
    chatTypeFacetCountPromise,
    workspaceFacetPromise,
    editorFacetPromise,
    mimeTypeFacetPromise,
  ]);

  const scoredHits = [
    ...entityRows.map(mapEntityHit),
    ...matterRows.map(mapMatterHit),
    ...contactRows.map(mapContactHit),
    ...caseLawRows.map(mapCaseLawHit),
    ...chatRows.map(mapChatHit),
    // hit.id tiebreak for deterministic ranking, not display text
  ].sort(compareScoredSearchHits);

  const page = paginateScoredSearchHits({
    scoredHits:
      legacyOffset === null ? scoredHits : scoredHits.slice(legacyOffset),
    limit: pageLimit,
    seen,
  });
  const totalEntities = totalFrom(entityCount);
  const totalMatters = totalFrom(matterCount);
  const totalContacts = totalFrom(contactCount);
  const totalCaseLaw = totalFrom(caseLawCount);
  const totalChat = totalFrom(chatCount);
  const totalCount =
    totalEntities + totalMatters + totalContacts + totalCaseLaw + totalChat;

  const typeFacetMap = new Map<string, { count: number }>();
  for (const row of entityTypeFacetRows) {
    typeFacetMap.set(String(row["value"]), { count: Number(row["count"]) });
  }
  const matterFacetCount = shouldSearchType(selected, "matter")
    ? totalMatters
    : totalFrom(matterTypeFacetCount);
  const contactFacetCount = shouldSearchType(selected, "contact")
    ? totalContacts
    : totalFrom(contactTypeFacetCount);
  const caseLawFacetCount = shouldSearchType(selected, "case-law")
    ? totalCaseLaw
    : totalFrom(caseLawTypeFacetCount);
  const chatFacetCount = shouldSearchType(selected, "chat")
    ? totalChat
    : totalFrom(chatTypeFacetCount);
  if (matterFacetCount > 0) {
    typeFacetMap.set("matter", { count: matterFacetCount });
  }
  if (contactFacetCount > 0) {
    typeFacetMap.set("contact", { count: contactFacetCount });
  }
  if (caseLawFacetCount > 0) {
    typeFacetMap.set("case-law", { count: caseLawFacetCount });
  }
  if (chatFacetCount > 0) {
    typeFacetMap.set("chat", { count: chatFacetCount });
  }

  const workspaceFacetMap = toStringFacetMap(workspaceFacetRows);
  const editorFacetMap = toStringFacetMap(editorFacetRows);
  const mimeTypeFacetMap = toMimeTypeFacetMap(mimeTypeFacetRows);

  return {
    hits: page.items,
    facets: {
      type: facetBuckets(typeFacetMap),
      workspace: facetBuckets(workspaceFacetMap),
      editor: facetBuckets(editorFacetMap),
      mimeType: facetBuckets(mimeTypeFacetMap),
    },
    totalCount,
    nextCursor: page.nextCursor,
  };
};

// ---------------------------------------------------------------------------
// Per-facet bucket search — used when a user types in a facet's search box
// to look up bucket values that the top-N default may have hidden.
// ---------------------------------------------------------------------------

export type GlobalFacetName = "editor" | "workspace" | "mimeType";

export type GlobalFacetSearchQuery = {
  facet: GlobalFacetName;
  /** Substring filter on the facet's bucket label. Empty = no filter. */
  search: string;
  query: string;
  organizationId: SafeId<"organization">;
  accessibleWorkspaceIds: readonly SafeId<"workspace">[];
  selectedWorkspaceIds: readonly SafeId<"workspace">[];
  types: readonly GlobalSearchResultType[];
  editedByUserIds: readonly string[];
  mimeTypes: readonly string[];
  updatedFrom?: string | undefined;
  updatedTo?: string | undefined;
  limit: number;
};

const escapeLikePattern = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

const labelLikeFilter = (column: SQL, search: string): SQL => {
  const trimmed = search.trim();
  if (!trimmed) {
    return sql``;
  }
  const pattern = `%${escapeLikePattern(trimmed)}%`;
  return sql`AND ${column} ILIKE ${pattern}`;
};

export const searchGlobalFacet = async (
  {
    facet,
    search,
    query,
    organizationId,
    accessibleWorkspaceIds,
    selectedWorkspaceIds,
    types,
    editedByUserIds,
    mimeTypes,
    updatedFrom,
    updatedTo,
    limit,
  }: GlobalFacetSearchQuery,
  database: Pick<typeof rootDb, "execute"> = rootDb,
): Promise<{ buckets: FacetBucket[] }> => {
  const {
    selected,
    restrictToEntities,
    entityEditorFilter,
    entityMimeFilter,
    entityUpdatedFilter,
    matterUpdatedFilter,
    entityTextSearchFilter,
    matterTextSearchFilter,
    entityTypeFilter,
  } = buildSearchFilterFragments({
    query,
    types,
    editedByUserIds,
    mimeTypes,
    updatedFrom,
    updatedTo,
  });
  const entityWorkspaceFilter = searchDocumentsAccessSql({
    accessibleWorkspaceIds,
    selectedWorkspaceIds,
  });
  // Workspace facets intentionally ignore the current workspace selection so
  // every accessible sibling remains available as a bucket.
  const entityWorkspaceFacetFilter = searchDocumentsAccessSql({
    accessibleWorkspaceIds,
    selectedWorkspaceIds: [],
  });
  const matterWorkspaceFacetFilter = workspaceSearchDocumentsAccessSql({
    accessibleWorkspaceIds,
    selectedWorkspaceIds: [],
  });
  const selectedFileFieldJoin = fileFieldJoin(mimeTypes);
  const allFileFieldJoin = fileFieldJoin([]);

  if (facet === "editor") {
    if (!hasSelectedEntityType(selected)) {
      return { buckets: [] };
    }
    const rows = await database.execute(sql`
      SELECT editor.id AS value, editor.name AS label, count(*)::int AS count
      FROM search_documents sd
      LEFT JOIN entities e
        ON e.id = sd.entity_id
        AND e.workspace_id = sd.workspace_id
      JOIN "user" editor ON editor.id = e.last_edited_by
      ${selectedFileFieldJoin}
      WHERE sd.organization_id = ${organizationId}
        ${entityTypeFilter}
        ${entityMimeFilter}
        ${entityUpdatedFilter}
        ${entityTextSearchFilter}
        ${labelLikeFilter(sql`editor.name`, search)}
        ${entityWorkspaceFilter}
      GROUP BY editor.id, editor.name
      ORDER BY count DESC, editor.name ASC
      LIMIT ${limit}
    `);
    return { buckets: facetBuckets(toStringFacetMap(rows)) };
  }

  if (facet === "mimeType") {
    if (!hasSelectedEntityType(selected)) {
      return { buckets: [] };
    }
    const rows = await database.execute(sql`
      SELECT mime_type.value AS value, mime_type.value AS label, count(*)::int AS count
      FROM search_documents sd
      LEFT JOIN entities e
        ON e.id = sd.entity_id
        AND e.workspace_id = sd.workspace_id
      ${allFileFieldJoin}
      CROSS JOIN LATERAL unnest(
        coalesce(file_field.mime_types, ARRAY[]::text[])
      ) AS mime_type(value)
      WHERE sd.organization_id = ${organizationId}
        ${entityTypeFilter}
        ${entityEditorFilter}
        ${entityUpdatedFilter}
        ${entityTextSearchFilter}
        ${labelLikeFilter(sql`mime_type.value`, search)}
        ${entityWorkspaceFilter}
      GROUP BY mime_type.value
      ORDER BY count DESC, mime_type.value ASC
      LIMIT ${limit}
    `);
    return { buckets: facetBuckets(toMimeTypeFacetMap(rows)) };
  }

  // facet === "workspace"
  const includeEntities = hasSelectedEntityType(selected);
  const includeMatters =
    !restrictToEntities && shouldSearchType(selected, "matter");
  if (!includeEntities && !includeMatters) {
    return { buckets: [] };
  }

  const entityWorkspaceFacetQuery = includeEntities
    ? sql`
      SELECT sd.workspace_id AS value, w.name AS label
      FROM search_documents sd
      JOIN workspaces w ON w.id = sd.workspace_id
      LEFT JOIN entities e
        ON e.id = sd.entity_id
        AND e.workspace_id = sd.workspace_id
      ${selectedFileFieldJoin}
      WHERE sd.organization_id = ${organizationId}
        ${entityTypeFilter}
        ${entityEditorFilter}
        ${entityMimeFilter}
        ${entityUpdatedFilter}
        ${entityTextSearchFilter}
        ${entityWorkspaceFacetFilter}
    `
    : emptyWorkspaceFacetQuery;

  const matterWorkspaceFacetQuery = includeMatters
    ? sql`
      SELECT wsd.workspace_id AS value, wsd.title AS label
      FROM workspace_search_documents wsd
      WHERE wsd.organization_id = ${organizationId}
        ${matterUpdatedFilter}
        ${matterTextSearchFilter}
        ${matterWorkspaceFacetFilter}
    `
    : emptyWorkspaceFacetQuery;

  const rows = await database.execute(sql`
    SELECT value, label, count(*)::int AS count
    FROM (
      ${entityWorkspaceFacetQuery}
      UNION ALL
      ${matterWorkspaceFacetQuery}
    ) hits
    WHERE TRUE
      ${labelLikeFilter(sql`label`, search)}
    GROUP BY value, label
    ORDER BY count DESC, value ASC
    LIMIT ${limit}
  `);
  return { buckets: facetBuckets(toStringFacetMap(rows)) };
};

export const upsertContactSearchDocument = async (
  contactId: SafeId<"contact">,
): Promise<void> => {
  const contact = await rootDb.query.contacts.findFirst({
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
  const previewGeneration = Bun.randomUUIDv7();
  const previewPassages = buildSearchPreviewPassages(
    contact.displayName,
    searchableText,
  );

  await rootDb.transaction(async (tx) => {
    await tx.execute(sql`
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
          unaccent(arabic_normalize(
            coalesce(${contact.displayName}, '') || ' ' ||
            coalesce(${searchableText}, '')
          ))
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
    await tx.execute(sql`
      DELETE FROM contact_search_document_preview_passages
      WHERE contact_id = ${contact.id}
    `);
    await tx.execute(sql`
      INSERT INTO contact_search_document_preview_passages (
        contact_id, organization_id, generation, ordinal, content, tsv
      ) VALUES ${buildSearchPreviewPassageValueRows({
        generation: previewGeneration,
        leadingValues: [sql`${contact.id}`, sql`${contact.organizationId}`],
        passages: previewPassages,
        regconfig: sql`'simple'`,
        useUnaccent: true,
      })}
    `);
    await tx.execute(sql`
      UPDATE contact_search_documents
      SET preview_generation = ${previewGeneration}::uuid
      WHERE contact_id = ${contact.id}
    `);
  });
};

export const upsertWorkspaceSearchDocument = async (
  workspaceId: SafeId<"workspace">,
): Promise<void> => {
  const workspace = await rootDb.query.workspaces.findFirst({
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
  const previewGeneration = Bun.randomUUIDv7();
  const previewPassages = buildSearchPreviewPassages(
    workspace.name,
    searchableText,
  );

  await rootDb.transaction(async (tx) => {
    await tx.execute(sql`
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
          unaccent(arabic_normalize(
            coalesce(${workspace.name}, '') || ' ' ||
            coalesce(${searchableText}, '')
          ))
        )
      )
      ON CONFLICT (workspace_id) DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        title = EXCLUDED.title,
        searchable_text = EXCLUDED.searchable_text,
        updated_at = EXCLUDED.updated_at,
        tsv = EXCLUDED.tsv
    `);
    await tx.execute(sql`
      DELETE FROM workspace_search_document_preview_passages
      WHERE workspace_id = ${workspace.id}
    `);
    await tx.execute(sql`
      INSERT INTO workspace_search_document_preview_passages (
        workspace_id, organization_id, generation, ordinal, content, tsv
      ) VALUES ${buildSearchPreviewPassageValueRows({
        generation: previewGeneration,
        leadingValues: [sql`${workspace.id}`, sql`${workspace.organizationId}`],
        passages: previewPassages,
        regconfig: sql`'simple'`,
        useUnaccent: true,
      })}
    `);
    await tx.execute(sql`
      UPDATE workspace_search_documents
      SET preview_generation = ${previewGeneration}::uuid
      WHERE workspace_id = ${workspace.id}
    `);
  });
};

type SearchActivityDatabase = {
  execute: (query: SQL) => Promise<unknown>;
};

export const syncWorkspaceSearchActivity = async (
  workspaceId: SafeId<"workspace">,
  db: SearchActivityDatabase = rootDb,
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
  const contact = await rootDb.query.contacts.findFirst({
    where: { id: { eq: contactId } },
    columns: { organizationId: true },
  });

  if (!contact) {
    return;
  }

  const rows = await rootDb
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
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- keyset page per iteration; the page is the batch
    const batch = await rootDb
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
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- keyset page per iteration; the page is the batch
    const batch = await rootDb
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
