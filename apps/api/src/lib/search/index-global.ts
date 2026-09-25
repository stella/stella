import { panic } from "better-result";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { isEntityKind, resourceRef, RESOURCE_TYPE } from "@stll/api-contract";
import { compareCodeUnit } from "@stll/collation";
import { Temporal } from "@stll/time";

import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { contacts, workspaceContacts, workspaces } from "@/api/db/schema";
import type {
  ContactAddress,
  ContactEmail,
  ContactPhone,
} from "@/api/db/schema-validators";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { decisionIdentifierProjection } from "@/api/lib/case-law/decision-identifiers";
import { readPublicDecisionLanguageAlternatesForGroupKeys } from "@/api/lib/case-law/language-alternates";
import type { PublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";
import { publicCaseLawDecisionJoin } from "@/api/lib/case-law/search-sql";
import { escapeLike } from "@/api/lib/escape-like";
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
const GLOBAL_SEARCH_FACET_LIMIT = 20;
const MATTER_RELEVANCE_BOOST = 0.15;

type RawRow = Record<string, unknown>;
type CountRow = { total?: unknown };

type ScoredGlobalSearchHit = {
  hit: GlobalSearchHit;
  score: number;
};

type SearchPromise = Promise<RawRow[]>;

type ReadLanguageAlternates = (
  languageGroupKeys: readonly string[],
) => Promise<PublicDecisionLanguageAlternatesByGroup>;

type SearchReadTransaction = Pick<Transaction, "execute">;

type SearchGlobalReaders = {
  /** The request's scoped handle; every tenant read runs under its policies. */
  scopedDb: ScopedDb;
  /** Language versions come from the public-law reader, as on every other
   *  decision response. */
  readLanguageAlternates?: ReadLanguageAlternates;
};

type GlobalSearchRead = {
  result: GlobalSearchResult;
  /** Language group of each fetched decision, keyed by decision id. */
  caseLawLanguageGroups: ReadonlyMap<string, string>;
};

/**
 * Language versions of the case-law hits on the page, read in one batch on
 * the public-law reader once the tenant transaction has finished.
 */
const withLanguageAlternates = async (
  { result, caseLawLanguageGroups }: GlobalSearchRead,
  readLanguageAlternates: ReadLanguageAlternates,
): Promise<GlobalSearchResult> => {
  const pageGroupKeys = new Set(
    result.hits.flatMap((hit) => {
      const key =
        hit.type === "case-law"
          ? caseLawLanguageGroups.get(hit.decisionId)
          : undefined;
      return key === undefined ? [] : [key];
    }),
  );
  if (pageGroupKeys.size === 0) {
    return result;
  }
  const alternates = await readLanguageAlternates([...pageGroupKeys]);
  return {
    ...result,
    hits: result.hits.map((hit) =>
      hit.type === "case-law"
        ? {
            ...hit,
            // One entry per language already; the rest of each version stays
            // off the wire, since a hit only needs to know whether to name
            // its language.
            languageAlternates: alternates
              .alternatesFor(caseLawLanguageGroups.get(hit.decisionId) ?? null)
              .map(({ language }) => ({ language })),
          }
        : hit,
    ),
  };
};

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
    slug: toNullableString(row["slug"]),
    language: String(row["language"]),
    // Filled in for the page's hits after the tenant transaction.
    languageAlternates: [],
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
    .toSorted((a, b) => b.count - a.count || compareCodeUnit(a.value, b.value));

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
    updatedFrom === undefined
      ? undefined
      : Temporal.Instant.from(updatedFrom).toString({
          fractionalSecondDigits: 3,
        });
  const normalizedUpdatedTo =
    updatedTo === undefined
      ? undefined
      : Temporal.Instant.from(updatedTo).toString({
          fractionalSecondDigits: 3,
        });

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

const readGlobalSearch = async (
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
  database: SearchReadTransaction,
): Promise<GlobalSearchRead> => {
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
        d.slug,
        d.language,
        d.language_group_key,
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
      ${publicCaseLawDecisionJoin}
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
      ${publicCaseLawDecisionJoin}
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
  // shows the others as toggleable options. The inner join leaves out
  // documents whose editor profile the caller cannot see.
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
  ].toSorted(compareScoredSearchHits);

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

  const caseLawLanguageGroups = new Map(
    caseLawRows.flatMap((row) => {
      const key = toNullableString(row["language_group_key"]);
      return key === null ? [] : [[String(row["id"]), key] as const];
    }),
  );

  return {
    result: {
      hits: page.items,
      facets: {
        type: facetBuckets(typeFacetMap),
        workspace: facetBuckets(workspaceFacetMap),
        editor: facetBuckets(editorFacetMap),
        mimeType: facetBuckets(mimeTypeFacetMap),
      },
      totalCount,
      nextCursor: page.nextCursor,
    },
    caseLawLanguageGroups,
  };
};

/**
 * Tenant global search. Every statement runs in one transaction on the
 * request's scoped handle, so the database policies decide which rows,
 * editor profiles included, the caller can see.
 */
export const searchGlobal = async (
  query: GlobalSearchQuery,
  {
    scopedDb,
    readLanguageAlternates = readPublicDecisionLanguageAlternatesForGroupKeys,
  }: SearchGlobalReaders,
): Promise<GlobalSearchResult> =>
  await withLanguageAlternates(
    await scopedDb(async (tx) => await readGlobalSearch(query, tx)),
    readLanguageAlternates,
  );

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

const labelLikeFilter = (column: SQL, search: string): SQL => {
  const trimmed = search.trim();
  if (!trimmed) {
    return sql``;
  }
  const pattern = `%${escapeLike(trimmed)}%`;
  return sql`AND ${column} ILIKE ${pattern}`;
};

const readGlobalFacet = async (
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
  database: SearchReadTransaction,
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

/** Facet bucket lookup, read on the request's scoped handle. */
export const searchGlobalFacet = async (
  query: GlobalFacetSearchQuery,
  scopedDb: ScopedDb,
): Promise<{ buckets: FacetBucket[] }> =>
  await scopedDb(async (tx) => await readGlobalFacet(query, tx));

/**
 * The connection a contact or matter projection is rebuilt on. The caller
 * chooses it: the standing repair drain passes its own, and a request's
 * post-commit flush goes through `projection-repair-flush.ts`.
 */
type SearchDocumentDatabase = Pick<
  typeof rootDb,
  "query" | "select" | "transaction"
>;

// Contact and matter projections are rebuilt in batches of at most
// `REINDEX_BATCH_SIZE` sources. A batch is one read of the sources and their
// relations, then one transaction of four statements: the projection upsert,
// the preview-passage delete and insert, and the generation stamp. The work a
// rebuild does grows with its number of batches, not its number of sources.
// Every source in a batch shares the batch's preview generation, so each
// source's projection and passages are replaced together, atomically.

const writeContactProjections = async (
  contactIds: readonly SafeId<"contact">[],
  database: SearchDocumentDatabase,
): Promise<void> => {
  if (contactIds.length === 0) {
    return;
  }
  const sources = await database.query.contacts.findMany({
    where: { id: { in: [...contactIds] } },
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
    // Id order is the order the batch locks projection rows in.
    orderBy: { id: "asc" },
    limit: contactIds.length,
  });
  if (sources.length === 0) {
    return;
  }

  const projections = sources.map((contact) => {
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
    return {
      contact,
      searchableText,
      passages: buildSearchPreviewPassages(contact.displayName, searchableText),
    };
  });
  const previewGeneration = Bun.randomUUIDv7();
  const ids = projections.map(({ contact }) => contact.id);

  await database.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO contact_search_documents (
        contact_id, organization_id, contact_type,
        title, searchable_text, updated_at, tsv
      ) VALUES ${sql.join(
        projections.map(
          ({ contact, searchableText }) => sql`(
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
          )`,
        ),
        sql`, `,
      )}
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
      WHERE contact_id = ANY(${typedPgArray(ids, "uuid")})
    `);
    await tx.execute(sql`
      INSERT INTO contact_search_document_preview_passages (
        contact_id, organization_id, generation, ordinal, content, tsv
      ) VALUES ${sql.join(
        projections.map(({ contact, passages }) =>
          buildSearchPreviewPassageValueRows({
            generation: previewGeneration,
            leadingValues: [sql`${contact.id}`, sql`${contact.organizationId}`],
            passages,
            regconfig: sql`'simple'`,
            useUnaccent: true,
          }),
        ),
        sql`, `,
      )}
    `);
    await tx.execute(sql`
      UPDATE contact_search_documents
      SET preview_generation = ${previewGeneration}::uuid
      WHERE contact_id = ANY(${typedPgArray(ids, "uuid")})
    `);
  });
};

const writeWorkspaceProjections = async (
  workspaceIds: readonly SafeId<"workspace">[],
  database: SearchDocumentDatabase,
): Promise<void> => {
  if (workspaceIds.length === 0) {
    return;
  }
  const sources = await database.query.workspaces.findMany({
    where: { id: { in: [...workspaceIds] } },
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
    // Id order is the order the batch locks projection rows in.
    orderBy: { id: "asc" },
    limit: workspaceIds.length,
  });
  if (sources.length === 0) {
    return;
  }

  const projections = sources.map((workspace) => {
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
    return {
      workspace,
      searchableText,
      updatedAt,
      passages: buildSearchPreviewPassages(workspace.name, searchableText),
    };
  });
  const previewGeneration = Bun.randomUUIDv7();
  const ids = projections.map(({ workspace }) => workspace.id);

  await database.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO workspace_search_documents (
        workspace_id, organization_id,
        title, searchable_text, updated_at, tsv
      ) VALUES ${sql.join(
        projections.map(
          ({ workspace, searchableText, updatedAt }) => sql`(
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
          )`,
        ),
        sql`, `,
      )}
      ON CONFLICT (workspace_id) DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        title = EXCLUDED.title,
        searchable_text = EXCLUDED.searchable_text,
        updated_at = EXCLUDED.updated_at,
        tsv = EXCLUDED.tsv
    `);
    await tx.execute(sql`
      DELETE FROM workspace_search_document_preview_passages
      WHERE workspace_id = ANY(${typedPgArray(ids, "uuid")})
    `);
    await tx.execute(sql`
      INSERT INTO workspace_search_document_preview_passages (
        workspace_id, organization_id, generation, ordinal, content, tsv
      ) VALUES ${sql.join(
        projections.map(({ workspace, passages }) =>
          buildSearchPreviewPassageValueRows({
            generation: previewGeneration,
            leadingValues: [
              sql`${workspace.id}`,
              sql`${workspace.organizationId}`,
            ],
            passages,
            regconfig: sql`'simple'`,
            useUnaccent: true,
          }),
        ),
        sql`, `,
      )}
    `);
    await tx.execute(sql`
      UPDATE workspace_search_documents
      SET preview_generation = ${previewGeneration}::uuid
      WHERE workspace_id = ANY(${typedPgArray(ids, "uuid")})
    `);
  });
};

export const upsertContactSearchDocument = async (
  contactId: SafeId<"contact">,
  database: SearchDocumentDatabase,
): Promise<void> => {
  await writeContactProjections([contactId], database);
};

export const upsertWorkspaceSearchDocuments = async (
  workspaceIds: readonly SafeId<"workspace">[],
  database: SearchDocumentDatabase,
): Promise<void> => {
  // Sorted, so every writer locks projection rows in one order (the keyset
  // order) and two overlapping cascades wait on each other instead of
  // deadlocking.
  const pending = [...new Set(workspaceIds)].toSorted(compareCodeUnit);
  for (let start = 0; start < pending.length; start += REINDEX_BATCH_SIZE) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- one batch of at most REINDEX_BATCH_SIZE matters per iteration: one read and one four-statement transaction per batch, never per matter
    await writeWorkspaceProjections(
      pending.slice(start, start + REINDEX_BATCH_SIZE),
      database,
    );
  }
};

export const upsertWorkspaceSearchDocument = async (
  workspaceId: SafeId<"workspace">,
  database: SearchDocumentDatabase,
): Promise<void> => {
  await writeWorkspaceProjections([workspaceId], database);
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

export const reindexWorkspacesForContact = async (
  contactId: SafeId<"contact">,
  database: SearchDocumentDatabase,
): Promise<void> => {
  const contact = await database.query.contacts.findFirst({
    where: { id: { eq: contactId } },
    columns: { organizationId: true },
  });

  if (!contact) {
    return;
  }

  const rows = await database
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

  await upsertWorkspaceSearchDocuments(
    rows.map(({ id }) => id),
    database,
  );
};

export const rebuildSupplementalSearchIndex = async (
  organizationId: SafeId<"organization">,
): Promise<void> => {
  await rebuildSupplementalSearchDocuments(organizationId, rootDb);
};

type KeysetPage<Id extends string> = { last: Id | null; more: boolean };

// One keyset page of an organization's contacts, rebuilt as one batch.
const rebuildContactPage = async (
  organizationId: SafeId<"organization">,
  after: SafeId<"contact"> | null,
  database: SearchDocumentDatabase,
): Promise<KeysetPage<SafeId<"contact">>> => {
  const page = await database
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      after
        ? and(
            eq(contacts.organizationId, organizationId),
            gt(contacts.id, after),
          )
        : eq(contacts.organizationId, organizationId),
    )
    .orderBy(asc(contacts.id))
    .limit(REINDEX_BATCH_SIZE);
  await writeContactProjections(
    page.map(({ id }) => id),
    database,
  );
  return {
    last: page.at(-1)?.id ?? after,
    more: page.length === REINDEX_BATCH_SIZE,
  };
};

// One keyset page of an organization's matters, rebuilt as one batch.
const rebuildWorkspacePage = async (
  organizationId: SafeId<"organization">,
  after: SafeId<"workspace"> | null,
  database: SearchDocumentDatabase,
): Promise<KeysetPage<SafeId<"workspace">>> => {
  const page = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      after
        ? and(
            eq(workspaces.organizationId, organizationId),
            gt(workspaces.id, after),
          )
        : eq(workspaces.organizationId, organizationId),
    )
    .orderBy(asc(workspaces.id))
    .limit(REINDEX_BATCH_SIZE);
  await writeWorkspaceProjections(
    page.map(({ id }) => id),
    database,
  );
  return {
    last: page.at(-1)?.id ?? after,
    more: page.length === REINDEX_BATCH_SIZE,
  };
};

// Keyset pages of one organization's contacts, then its matters. Each page
// is one batch: a read of its sources and one projection transaction.
export const rebuildSupplementalSearchDocuments = async (
  organizationId: SafeId<"organization">,
  database: SearchDocumentDatabase,
): Promise<void> => {
  let contactPage: KeysetPage<SafeId<"contact">> = { last: null, more: true };
  while (contactPage.more) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- keyset page per iteration; the page is the batch
    contactPage = await rebuildContactPage(
      organizationId,
      contactPage.last,
      database,
    );
  }

  let workspacePage: KeysetPage<SafeId<"workspace">> = {
    last: null,
    more: true,
  };
  while (workspacePage.more) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- keyset page per iteration; the page is the batch
    workspacePage = await rebuildWorkspacePage(
      organizationId,
      workspacePage.last,
      database,
    );
  }
};
