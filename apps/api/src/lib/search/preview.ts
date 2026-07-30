import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { redistributableSourceJoin } from "@/api/lib/case-law/search-sql";
import { chatThreadScopeSql } from "@/api/lib/search/chat-thread-scope-sql";
import {
  contactWorkspaceAccessSql,
  searchDocumentsAccessSql,
  workspaceSearchDocumentsAccessSql,
} from "@/api/lib/search/contact-workspace-access-sql";
import {
  escapeAndHighlight,
  restoreOriginalSearchPreview,
  SEARCH_PREVIEW_HEADLINE_CONFIG,
} from "@/api/lib/search/highlight";
import {
  SEARCH_PREVIEW_SOURCE_CHARACTER_LIMIT,
  SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT,
} from "@/api/lib/search/preview-passages";
import {
  buildSearchPreviewLocatorTsQuery,
  buildSearchTsQuery,
} from "@/api/lib/search/query";
import type { GlobalSearchResultType } from "@/api/lib/search/types";

type SearchPreviewQuery = {
  query: string;
  resultId: string;
  type: GlobalSearchResultType;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  accessibleWorkspaceIds: readonly SafeId<"workspace">[];
};

type SearchPreview =
  | {
      content: string;
      type: "highlighted-html";
    }
  | {
      content: string;
      type: "plain-text";
    };

const SEARCH_PREVIEW_BODY_CHARACTER_LIMIT =
  SEARCH_PREVIEW_SOURCE_CHARACTER_LIMIT -
  SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT -
  1;
const SEARCH_PREVIEW_RESPONSE_CHARACTER_LIMIT = 16_000;
const SEARCH_PREVIEW_NORMALIZED_SOURCE_CHARACTER_LIMIT = 100_000;

type PreviewTextConfig = {
  normalize: (text: SQL) => SQL;
  regconfig: SQL;
  useUnaccent: SQL;
};

type PreviewHeadlineOptions = PreviewTextConfig & {
  sourceContent: SQL;
  tsQuery: SQL;
};

type PreviewContentOptions = PreviewTextConfig & {
  body: SQL;
  passageContent: SQL | null;
  title: SQL;
  headlineTsQuery: SQL | null;
};

const normalizeSearchPreviewText = (text: SQL): SQL =>
  sql`unaccent(arabic_normalize(${text}))`;

const normalizeCaseLawPreviewText = (text: SQL): SQL => sql`
  CASE
    WHEN coalesce(clfc.use_unaccent, true)
    THEN unaccent(arabic_normalize(${text}))
    ELSE arabic_normalize(${text})
  END
`;

// PostgreSQL finds and marks passages in index-normalized text. The original
// bounded source travels beside it so readSearchPreview can restore the exact
// legal text around those markers before HTML rendering.
const previewHeadline = (options: PreviewHeadlineOptions) => {
  return sql`
    (
      SELECT json_build_object(
        'content',
        left(
          ts_headline(
            ${options.regconfig},
            normalized_preview_source.content,
            ${options.tsQuery},
            ${SEARCH_PREVIEW_HEADLINE_CONFIG}
          ),
          ${SEARCH_PREVIEW_RESPONSE_CHARACTER_LIMIT}
        ),
        'sourceContent',
        preview_source.content,
        'normalizedSourceContent',
        normalized_preview_source.content,
        'useUnaccent',
        ${options.useUnaccent}
      )
      FROM (VALUES (${options.sourceContent})) AS preview_source(content)
      CROSS JOIN LATERAL (
        SELECT left(
          ${options.normalize(sql`preview_source.content`)},
          ${SEARCH_PREVIEW_NORMALIZED_SOURCE_CHARACTER_LIMIT}
        ) AS content
      ) normalized_preview_source
    ) AS preview
  `;
};

const previewUnhighlighted = (title: SQL, body: SQL) => sql`
  left(
    left(${title}, ${SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT})
      || ' ' ||
    left(${body}, ${SEARCH_PREVIEW_BODY_CHARACTER_LIMIT}),
    ${SEARCH_PREVIEW_RESPONSE_CHARACTER_LIMIT}
  )
`;

const previewContent = ({
  body,
  passageContent,
  normalize,
  regconfig,
  title,
  headlineTsQuery,
  useUnaccent,
}: PreviewContentOptions): SQL =>
  headlineTsQuery
    ? (() => {
        const boundedHead = sql`
          left(${title}, ${SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT})
            || ' ' ||
          left(${body}, ${SEARCH_PREVIEW_BODY_CHARACTER_LIMIT})
        `;
        return previewHeadline({
          normalize,
          regconfig,
          sourceContent: passageContent
            ? sql`coalesce(${passageContent}, ${boundedHead})`
            : boundedHead,
          tsQuery: headlineTsQuery,
          useUnaccent,
        });
      })()
    : sql`
        json_build_object(
          'content',
          ${previewUnhighlighted(title, body)},
          'sourceContent',
          NULL,
          'normalizedSourceContent',
          NULL,
          'useUnaccent',
          ${useUnaccent}
        ) AS preview
      `;

const previewTextFilter = (searchVector: SQL, tsQuery: SQL | null): SQL =>
  tsQuery ? sql`AND ${searchVector} @@ ${tsQuery}` : sql.empty();

type PreviewPassageJoinOptions = {
  generation: SQL;
  locatorTsQuery: SQL | null;
  parentFilter: SQL;
  table: SQL;
  tenantFilter?: SQL | undefined;
};

const previewPassageJoin = ({
  generation,
  locatorTsQuery,
  parentFilter,
  table,
  tenantFilter = sql.empty(),
}: PreviewPassageJoinOptions): SQL => {
  if (!locatorTsQuery) {
    return sql.empty();
  }
  return sql`
    LEFT JOIN LATERAL (
      (
        SELECT passage.content, passage.ordinal, 0 AS priority
        FROM ${table} passage
        WHERE ${parentFilter}
          AND passage.generation = ${generation}
          ${tenantFilter}
          AND passage.tsv @@ ${locatorTsQuery}
        ORDER BY passage.ordinal
        LIMIT 1
      )
      UNION ALL
      (
        SELECT passage.content, passage.ordinal, 1 AS priority
        FROM ${table} passage
        WHERE ${parentFilter}
          AND passage.generation = ${generation}
          ${tenantFilter}
          AND passage.ordinal = 0
        LIMIT 1
      )
      ORDER BY priority, ordinal
      LIMIT 1
    ) preview_passage ON true
  `;
};

export const buildSearchPreviewQuery = ({
  query,
  resultId,
  type,
  organizationId,
  userId,
  accessibleWorkspaceIds,
}: SearchPreviewQuery): SQL => {
  const tsQuery = query.trim() ? buildSearchTsQuery(query) : null;
  const locatorTsQuery = query.trim()
    ? buildSearchPreviewLocatorTsQuery(query)
    : null;
  const workspaceScope = {
    accessibleWorkspaceIds,
    selectedWorkspaceIds: [],
  };

  switch (type) {
    case "matter":
      return sql`
        SELECT ${previewContent({
          body: sql`wsd.searchable_text`,
          headlineTsQuery: locatorTsQuery,
          normalize: normalizeSearchPreviewText,
          passageContent: sql`preview_passage.content`,
          regconfig: sql`'simple'::regconfig`,
          title: sql`wsd.title`,
          useUnaccent: sql`true`,
        })}
        FROM workspace_search_documents wsd
        ${previewPassageJoin({
          generation: sql`wsd.preview_generation`,
          locatorTsQuery,
          parentFilter: sql`passage.workspace_id = wsd.workspace_id`,
          table: sql`workspace_search_document_preview_passages`,
          tenantFilter: sql`
            AND passage.organization_id = ${organizationId}
            AND passage.workspace_id = wsd.workspace_id
          `,
        })}
        WHERE wsd.workspace_id = ${resultId}
          AND wsd.organization_id = ${organizationId}
          ${previewTextFilter(sql`wsd.tsv`, tsQuery)}
          ${workspaceSearchDocumentsAccessSql({
            ...workspaceScope,
          })}
        LIMIT 1
      `;
    case "contact":
      return sql`
        SELECT ${previewContent({
          body: sql`csd.searchable_text`,
          headlineTsQuery: locatorTsQuery,
          normalize: normalizeSearchPreviewText,
          passageContent: sql`preview_passage.content`,
          regconfig: sql`'simple'::regconfig`,
          title: sql`csd.title`,
          useUnaccent: sql`true`,
        })}
        FROM contact_search_documents csd
        ${previewPassageJoin({
          generation: sql`csd.preview_generation`,
          locatorTsQuery,
          parentFilter: sql`passage.contact_id = csd.contact_id`,
          table: sql`contact_search_document_preview_passages`,
          tenantFilter: sql`AND passage.organization_id = ${organizationId}`,
        })}
        WHERE csd.contact_id = ${resultId}
          AND csd.organization_id = ${organizationId}
          ${previewTextFilter(sql`csd.tsv`, tsQuery)}
          ${contactWorkspaceAccessSql({
            organizationId,
            ...workspaceScope,
          })}
        LIMIT 1
      `;
    case "case-law":
      return sql`
        SELECT ${previewContent({
          body: sql`clsd.searchable_text`,
          headlineTsQuery: locatorTsQuery,
          normalize: normalizeCaseLawPreviewText,
          passageContent: sql`preview_passage.content`,
          regconfig: sql`clsd.regconfig::regconfig`,
          title: sql`clsd.title`,
          useUnaccent: sql`coalesce(clfc.use_unaccent, true)`,
        })}
        FROM case_law_search_documents clsd
        JOIN case_law_decisions d ON d.id = clsd.decision_id
        LEFT JOIN case_law_fts_configs clfc ON clfc.language = clsd.language
        ${redistributableSourceJoin}
        ${previewPassageJoin({
          generation: sql`clsd.preview_generation`,
          locatorTsQuery,
          parentFilter: sql`passage.decision_id = clsd.decision_id`,
          table: sql`case_law_search_document_preview_passages`,
        })}
        WHERE clsd.decision_id = ${resultId}
          ${previewTextFilter(sql`clsd.tsv`, tsQuery)}
        LIMIT 1
      `;
    case "chat":
      return sql`
        SELECT ${previewContent({
          body: sql`cst.searchable_text`,
          headlineTsQuery: locatorTsQuery,
          normalize: normalizeSearchPreviewText,
          passageContent: sql`preview_passage.content`,
          regconfig: sql`'simple'::regconfig`,
          title: sql`cst.title`,
          useUnaccent: sql`true`,
        })}
        FROM chat_thread_search_documents cst
        JOIN chat_threads t ON t.id = cst.thread_id
        ${previewPassageJoin({
          generation: sql`cst.preview_generation`,
          locatorTsQuery,
          parentFilter: sql`passage.thread_id = cst.thread_id`,
          table: sql`chat_thread_search_preview_passages`,
        })}
        WHERE cst.thread_id = ${resultId}
          ${previewTextFilter(sql`cst.tsv`, tsQuery)}
          AND ${chatThreadScopeSql({
            userId,
            organizationId,
            accessibleWorkspaceIds,
            selectedWorkspaceIds: [],
          })}
        LIMIT 1
      `;
    case "document":
    case "folder":
    case "task":
    case "message":
    case "link":
      return sql`
        SELECT ${previewContent({
          body: sql`sd.searchable_text`,
          headlineTsQuery: locatorTsQuery,
          normalize: normalizeSearchPreviewText,
          passageContent: sql`preview_passage.content`,
          regconfig: sql`coalesce(sd.language, 'simple')::regconfig`,
          title: sql`sd.title`,
          useUnaccent: sql`true`,
        })}
        FROM search_documents sd
        ${previewPassageJoin({
          generation: sql`sd.preview_generation`,
          locatorTsQuery,
          parentFilter: sql`passage.entity_id = sd.entity_id`,
          table: sql`search_document_preview_passages`,
          tenantFilter: sql`
            AND passage.organization_id = ${organizationId}
            AND passage.workspace_id = sd.workspace_id
          `,
        })}
        WHERE sd.entity_id = ${resultId}
          AND sd.kind = ${type}
          AND sd.organization_id = ${organizationId}
          ${previewTextFilter(sql`sd.tsv`, tsQuery)}
          ${searchDocumentsAccessSql({
            ...workspaceScope,
          })}
        LIMIT 1
      `;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
};

type SearchPreviewRow =
  | {
      content: string;
      normalizedSourceContent: null;
      sourceContent: null;
      useUnaccent: boolean;
    }
  | {
      content: string;
      normalizedSourceContent: string;
      sourceContent: string;
      useUnaccent: boolean;
    };

const isSearchPreviewRow = (value: unknown): value is SearchPreviewRow =>
  typeof value === "object" &&
  value !== null &&
  "content" in value &&
  typeof value.content === "string" &&
  "sourceContent" in value &&
  "normalizedSourceContent" in value &&
  ((typeof value.sourceContent === "string" &&
    typeof value.normalizedSourceContent === "string") ||
    (value.sourceContent === null && value.normalizedSourceContent === null)) &&
  "useUnaccent" in value &&
  typeof value.useUnaccent === "boolean";

export const readSearchPreview = async (
  input: SearchPreviewQuery,
): Promise<SearchPreview | null> => {
  const rows = await rootDb.execute(buildSearchPreviewQuery(input));
  const preview = rows.at(0)?.["preview"];
  if (!isSearchPreviewRow(preview)) {
    return null;
  }

  if (preview.sourceContent === null) {
    return { type: "plain-text", content: preview.content };
  }
  const content = restoreOriginalSearchPreview({
    headline: preview.content,
    maxLength: SEARCH_PREVIEW_RESPONSE_CHARACTER_LIMIT,
    normalizedSource: preview.normalizedSourceContent,
    source: preview.sourceContent,
    useUnaccent: preview.useUnaccent,
  });
  return { type: "highlighted-html", content: escapeAndHighlight(content) };
};
