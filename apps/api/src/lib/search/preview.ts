import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { chatThreadScopeSql } from "@/api/lib/search/chat-thread-scope-sql";
import {
  contactWorkspaceAccessSql,
  workspaceAccessSql,
} from "@/api/lib/search/contact-workspace-access-sql";
import {
  escapeAndHighlight,
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
const SEARCH_PREVIEW_RESPONSE_CHARACTER_LIMIT = 16_000;

const previewHeadline = (title: SQL, body: SQL, tsQuery: SQL) => sql`
  left(
    ts_headline(
      'public.stella_unaccent'::regconfig,
      left(${title}, ${SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT})
        || ' ' ||
      left(${body}, ${SEARCH_PREVIEW_BODY_CHARACTER_LIMIT}),
      ${tsQuery},
      ${SEARCH_PREVIEW_HEADLINE_CONFIG}
    ),
    ${SEARCH_PREVIEW_RESPONSE_CHARACTER_LIMIT}
  ) AS content
`;

export const buildSearchPreviewQuery = ({
  query,
  resultId,
  type,
  organizationId,
  userId,
  accessibleWorkspaceIds,
}: SearchPreviewQuery): SQL => {
  const tsQuery = buildSearchTsQuery(query);
  const workspaceScope = {
    accessibleWorkspaceIds,
    selectedWorkspaceIds: [],
  };

  switch (type) {
    case "matter":
      return sql`
        SELECT ${previewHeadline(
          sql`wsd.title`,
          sql`wsd.searchable_text`,
          tsQuery,
        )}
        FROM workspace_search_documents wsd
        WHERE wsd.workspace_id = ${resultId}
          AND wsd.organization_id = ${organizationId}
          ${workspaceAccessSql({
            column: sql`wsd.workspace_id`,
            ...workspaceScope,
          })}
          AND wsd.tsv @@ ${tsQuery}
        LIMIT 1
      `;
    case "contact":
      return sql`
        SELECT ${previewHeadline(
          sql`csd.title`,
          sql`csd.searchable_text`,
          tsQuery,
        )}
        FROM contact_search_documents csd
        WHERE csd.contact_id = ${resultId}
          AND csd.organization_id = ${organizationId}
          ${contactWorkspaceAccessSql({
            organizationId,
            ...workspaceScope,
          })}
          AND csd.tsv @@ ${tsQuery}
        LIMIT 1
      `;
    case "case-law":
      return sql`
        SELECT ${previewHeadline(
          sql`clsd.title`,
          sql`clsd.searchable_text`,
          tsQuery,
        )}
        FROM case_law_search_documents clsd
        WHERE clsd.decision_id = ${resultId}
          AND clsd.tsv @@ ${tsQuery}
        LIMIT 1
      `;
    case "chat":
      return sql`
        SELECT ${previewHeadline(
          sql`cst.title`,
          sql`cst.searchable_text`,
          tsQuery,
        )}
        FROM chat_thread_search_documents cst
        JOIN chat_threads t ON t.id = cst.thread_id
        WHERE cst.thread_id = ${resultId}
          AND ${chatThreadScopeSql({
            userId,
            organizationId,
            accessibleWorkspaceIds,
            selectedWorkspaceIds: [],
          })}
          AND cst.tsv @@ ${tsQuery}
        LIMIT 1
      `;
    case "document":
    case "folder":
    case "task":
    case "message":
    case "link":
      return sql`
        SELECT ${previewHeadline(
          sql`sd.title`,
          sql`sd.searchable_text`,
          tsQuery,
        )}
        FROM search_documents sd
        WHERE sd.entity_id = ${resultId}
          AND sd.kind = ${type}
          AND sd.organization_id = ${organizationId}
          ${workspaceAccessSql({
            column: sql`sd.workspace_id`,
            ...workspaceScope,
          })}
          AND sd.tsv @@ ${tsQuery}
        LIMIT 1
      `;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
};

export const readSearchPreview = async (
  input: SearchPreviewQuery,
): Promise<SearchPreview | null> => {
  const rows = await rootDb.execute(buildSearchPreviewQuery(input));
  const content = rows.at(0)?.["content"];
  if (typeof content !== "string") {
    return null;
  }

  return { content: escapeAndHighlight(content) };
};
