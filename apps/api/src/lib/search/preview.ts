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
import { buildSearchTsQuery } from "@/api/lib/search/query";
import type { GlobalSearchResultType } from "@/api/lib/search/types";

type SearchPreviewQuery = {
  query: string;
  resultId: string;
  type: GlobalSearchResultType;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  accessibleWorkspaceIds: readonly SafeId<"workspace">[];
};

type SearchPreview = {
  content: string;
};

const SEARCH_PREVIEW_SOURCE_CHARACTER_LIMIT = 50_000;
const SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT = 1000;
const SEARCH_PREVIEW_BODY_CHARACTER_LIMIT =
  SEARCH_PREVIEW_SOURCE_CHARACTER_LIMIT -
  SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT -
  1;
const SEARCH_PREVIEW_BODY_CHUNK_STEP = 24_000;
const SEARCH_PREVIEW_BODY_CHUNK_LIMIT = 8;
const SEARCH_PREVIEW_BODY_MAX_CHUNK_START =
  1 + (SEARCH_PREVIEW_BODY_CHUNK_LIMIT - 1) * SEARCH_PREVIEW_BODY_CHUNK_STEP;
const SEARCH_PREVIEW_RESPONSE_CHARACTER_LIMIT = 16_000;

type PreviewTextConfig = {
  normalize: (text: SQL) => SQL;
  regconfig: SQL;
  useUnaccent: SQL;
};

type PreviewHeadlineOptions = PreviewTextConfig & {
  body: SQL;
  title: SQL;
  tsQuery: SQL;
};

type PreviewContentOptions = PreviewTextConfig & {
  body: SQL;
  title: SQL;
  tsQuery: SQL | null;
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

const previewBodyExcerpt = ({
  body,
  normalize,
  regconfig,
  title,
  tsQuery,
}: PreviewHeadlineOptions) => sql`
  CASE
    WHEN to_tsvector(
      ${regconfig},
      ${normalize(sql`left(${title}, ${SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT})`)}
    ) @@ ${tsQuery}
    THEN left(${body}, ${SEARCH_PREVIEW_BODY_CHARACTER_LIMIT})
    ELSE coalesce(
      (
        SELECT substring(
          ${body}
          FROM chunk_start
          FOR ${SEARCH_PREVIEW_BODY_CHARACTER_LIMIT}
        )
        FROM generate_series(
          1,
          ${SEARCH_PREVIEW_BODY_MAX_CHUNK_START},
          ${SEARCH_PREVIEW_BODY_CHUNK_STEP}
        ) AS chunks(chunk_start)
        WHERE to_tsvector(
            ${regconfig},
            ${normalize(sql`
              left(${title}, ${SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT})
                || ' ' ||
              substring(
                ${body}
                FROM chunk_start
                FOR ${SEARCH_PREVIEW_BODY_CHARACTER_LIMIT}
              )`)}
          ) @@ ${tsQuery}
        ORDER BY chunk_start
        LIMIT 1
      ),
      left(${body}, ${SEARCH_PREVIEW_BODY_CHARACTER_LIMIT})
    )
  END
`;

const previewSourceContent = (options: PreviewHeadlineOptions) => sql`
  left(${options.title}, ${SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT})
    || ' ' ||
  ${previewBodyExcerpt(options)}
`;

// PostgreSQL finds and marks passages in index-normalized text. The original
// bounded source travels beside it so readSearchPreview can restore the exact
// legal text around those markers before HTML rendering.
const previewHeadline = (options: PreviewHeadlineOptions) => {
  const sourceContent = previewSourceContent(options);
  return sql`
    (
      SELECT json_build_object(
        'content',
        left(
          ts_headline(
            ${options.regconfig},
            ${options.normalize(sql`preview_source.content`)},
            ${options.tsQuery},
            ${SEARCH_PREVIEW_HEADLINE_CONFIG}
          ),
          ${SEARCH_PREVIEW_RESPONSE_CHARACTER_LIMIT}
        ),
        'sourceContent',
        preview_source.content,
        'useUnaccent',
        ${options.useUnaccent}
      )
      FROM (VALUES (${sourceContent})) AS preview_source(content)
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
  normalize,
  regconfig,
  title,
  tsQuery,
  useUnaccent,
}: PreviewContentOptions): SQL =>
  tsQuery
    ? previewHeadline({
        body,
        normalize,
        regconfig,
        title,
        tsQuery,
        useUnaccent,
      })
    : sql`
        json_build_object(
          'content',
          ${previewUnhighlighted(title, body)},
          'sourceContent',
          NULL,
          'useUnaccent',
          ${useUnaccent}
        ) AS preview
      `;

const previewTextFilter = (searchVector: SQL, tsQuery: SQL | null): SQL =>
  tsQuery ? sql`AND ${searchVector} @@ ${tsQuery}` : sql.empty();

export const buildSearchPreviewQuery = ({
  query,
  resultId,
  type,
  organizationId,
  userId,
  accessibleWorkspaceIds,
}: SearchPreviewQuery): SQL => {
  const tsQuery = query.trim() ? buildSearchTsQuery(query) : null;
  const workspaceScope = {
    accessibleWorkspaceIds,
    selectedWorkspaceIds: [],
  };

  switch (type) {
    case "matter":
      return sql`
        SELECT ${previewContent({
          body: sql`wsd.searchable_text`,
          normalize: normalizeSearchPreviewText,
          regconfig: sql`'simple'::regconfig`,
          title: sql`wsd.title`,
          tsQuery,
          useUnaccent: sql`true`,
        })}
        FROM workspace_search_documents wsd
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
          normalize: normalizeSearchPreviewText,
          regconfig: sql`'simple'::regconfig`,
          title: sql`csd.title`,
          tsQuery,
          useUnaccent: sql`true`,
        })}
        FROM contact_search_documents csd
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
          normalize: normalizeCaseLawPreviewText,
          regconfig: sql`clsd.regconfig::regconfig`,
          title: sql`clsd.title`,
          tsQuery,
          useUnaccent: sql`coalesce(clfc.use_unaccent, true)`,
        })}
        FROM case_law_search_documents clsd
        JOIN case_law_decisions d ON d.id = clsd.decision_id
        LEFT JOIN case_law_fts_configs clfc ON clfc.language = clsd.language
        ${redistributableSourceJoin}
        WHERE clsd.decision_id = ${resultId}
          ${previewTextFilter(sql`clsd.tsv`, tsQuery)}
        LIMIT 1
      `;
    case "chat":
      return sql`
        SELECT ${previewContent({
          body: sql`cst.searchable_text`,
          normalize: normalizeSearchPreviewText,
          regconfig: sql`'simple'::regconfig`,
          title: sql`cst.title`,
          tsQuery,
          useUnaccent: sql`true`,
        })}
        FROM chat_thread_search_documents cst
        JOIN chat_threads t ON t.id = cst.thread_id
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
          normalize: normalizeSearchPreviewText,
          regconfig: sql`coalesce(sd.language, 'simple')::regconfig`,
          title: sql`sd.title`,
          tsQuery,
          useUnaccent: sql`true`,
        })}
        FROM search_documents sd
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

const isSearchPreviewRow = (
  value: unknown,
): value is {
  content: string;
  sourceContent: string | null;
  useUnaccent: boolean;
} =>
  typeof value === "object" &&
  value !== null &&
  "content" in value &&
  typeof value.content === "string" &&
  "sourceContent" in value &&
  (typeof value.sourceContent === "string" || value.sourceContent === null) &&
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

  const content =
    preview.sourceContent === null
      ? preview.content
      : restoreOriginalSearchPreview({
          headline: preview.content,
          maxLength: SEARCH_PREVIEW_RESPONSE_CHARACTER_LIMIT,
          source: preview.sourceContent,
          useUnaccent: preview.useUnaccent,
        });
  return { content: escapeAndHighlight(content) };
};
