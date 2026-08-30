import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { redistributableSourceJoin } from "@/api/lib/case-law/search-sql";
import { LIMITS } from "@/api/lib/limits";
import { CHAT_SEARCH_DISPLAY_METADATA_GENERATION } from "@/api/lib/search/chat-search-generation";
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
  truncateSearchPreviewAroundCandidates,
} from "@/api/lib/search/highlight";
import { normalizeSearchableChatMessageContent } from "@/api/lib/search/index-chat";
import { previewPassageJoin } from "@/api/lib/search/preview-passage-sql";
import {
  SEARCH_PREVIEW_SOURCE_CHARACTER_LIMIT,
  SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT,
} from "@/api/lib/search/preview-passages";
import {
  buildSearchPreviewLocatorTsQuery,
  buildSearchTsQuery,
  getSearchPreviewLocatorCandidates,
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
      messages: SearchPreviewChatMessage[];
      type: "chat-messages";
    }
  | {
      content: string;
      type: "highlighted-html";
    }
  | {
      content: string;
      type: "plain-text";
    };

type SearchPreviewChatMessage = {
  content: string;
  id: string;
  role: SearchPreviewChatRole;
};

type SearchPreviewChatMessageRow = {
  content: unknown;
  id: SafeId<"chatMessage">;
  isTarget: unknown;
  role: unknown;
};

type SearchPreviewChatRow = {
  isTitleOnlyMatch: unknown;
  messages: SearchPreviewChatMessageRow[];
  title: unknown;
};

type SearchPreviewChatRole = "assistant" | "system" | "user";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isSearchPreviewChatRole = (
  value: unknown,
): value is SearchPreviewChatRole =>
  value === "assistant" || value === "system" || value === "user";

const extractChatPreviewTextParts = (content: unknown): string[] => {
  const normalized = normalizeSearchableChatMessageContent(content);
  if (!normalized) {
    return [];
  }

  const textParts: string[] = [];
  for (const part of normalized.parts) {
    if (part.content.trim()) {
      textParts.push(part.content);
    }
  }

  const sourceDocuments = normalized.metadata.sourceDocuments;
  if (!sourceDocuments) {
    return textParts;
  }
  for (const sourceDocument of sourceDocuments) {
    if (!isRecord(sourceDocument)) {
      continue;
    }
    for (const value of [
      sourceDocument.title,
      sourceDocument.mention,
      sourceDocument.kind,
    ]) {
      if (typeof value === "string" && value.trim()) {
        textParts.push(value);
      }
    }
  }
  return textParts;
};

const SEARCH_PREVIEW_BODY_CHARACTER_LIMIT =
  SEARCH_PREVIEW_SOURCE_CHARACTER_LIMIT -
  SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT -
  1;
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
const previewHeadline = (options: PreviewHeadlineOptions) => sql`
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
          ${LIMITS.searchPreviewResponseCharacterLimit}
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

const previewUnhighlighted = (title: SQL, body: SQL) => sql`
  left(
    left(${title}, ${SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT})
      || ' ' ||
    left(${body}, ${SEARCH_PREVIEW_BODY_CHARACTER_LIMIT}),
    ${LIMITS.searchPreviewResponseCharacterLimit}
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

const chatPreviewTargetMessageId = (tsQuery: SQL | null): SQL => {
  const latestMessageId = sql`
    SELECT latest.message_id
    FROM chat_message_search_documents latest
    WHERE latest.thread_id = cst.thread_id
    ORDER BY latest.created_at DESC, latest.message_id DESC
    LIMIT 1
  `;

  if (!tsQuery) {
    return latestMessageId;
  }

  return sql`
    SELECT coalesce(
      (
        SELECT matching.message_id
        FROM chat_message_search_documents matching
        WHERE matching.thread_id = cst.thread_id
          AND matching.tsv @@ ${tsQuery}
        ORDER BY
          ts_rank_cd(matching.tsv, ${tsQuery}) DESC,
          matching.created_at DESC,
          matching.message_id DESC
        LIMIT 1
      ),
      (${latestMessageId})
    )
  `;
};

const chatPreviewTitleOnlyMatch = (tsQuery: SQL | null): SQL =>
  tsQuery
    ? sql`
        (
          to_tsvector(
            'simple',
            unaccent(arabic_normalize(coalesce(cst.title, '')))
          ) @@ ${tsQuery}
          AND NOT EXISTS (
            SELECT 1
            FROM chat_message_search_documents matching
            WHERE matching.thread_id = cst.thread_id
              AND matching.tsv @@ ${tsQuery}
          )
        ) AS "isTitleOnlyMatch"
      `
    : sql`false AS "isTitleOnlyMatch"`;

const chatPreviewMessages = (tsQuery: SQL | null): SQL => {
  const precedingLimit = tsQuery
    ? Math.ceil(LIMITS.searchChatPreviewMessageLimit / 2)
    : LIMITS.searchChatPreviewMessageLimit;
  const followingLimit = tsQuery
    ? LIMITS.searchChatPreviewMessageLimit - precedingLimit
    : 0;

  return sql`
    (
      WITH target AS (
        SELECT target_message.created_at, target_message.message_id
        FROM chat_message_search_documents target_message
        WHERE target_message.message_id = (${chatPreviewTargetMessageId(tsQuery)})
      ),
      preceding AS (
        SELECT
          candidate.message_id,
          candidate.role,
          candidate.created_at
        FROM chat_message_search_documents candidate
        CROSS JOIN target
        WHERE candidate.thread_id = cst.thread_id
          AND (candidate.created_at, candidate.message_id)
            <= (target.created_at, target.message_id)
        ORDER BY candidate.created_at DESC, candidate.message_id DESC
        LIMIT ${precedingLimit}
      ),
      following AS (
        SELECT
          candidate.message_id,
          candidate.role,
          candidate.created_at
        FROM chat_message_search_documents candidate
        CROSS JOIN target
        WHERE candidate.thread_id = cst.thread_id
          AND (candidate.created_at, candidate.message_id)
            > (target.created_at, target.message_id)
        ORDER BY candidate.created_at, candidate.message_id
        LIMIT ${followingLimit}
      ),
      nearby AS (
        SELECT * FROM preceding
        UNION ALL
        SELECT * FROM following
      )
      SELECT coalesce(
        json_agg(
          json_build_object(
            'id', nearby.message_id,
            'role', nearby.role,
            'content', message.content,
            'isTarget', nearby.message_id = target.message_id
          )
          ORDER BY nearby.created_at, nearby.message_id
        ),
        '[]'::json
      )
      FROM nearby
      CROSS JOIN target
      JOIN chat_messages message ON message.id = nearby.message_id
    ) AS messages
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
          table: "matter",
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
          table: "contact",
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
          table: "case-law",
        })}
        WHERE clsd.decision_id = ${resultId}
          ${previewTextFilter(sql`clsd.tsv`, tsQuery)}
        LIMIT 1
      `;
    case "chat":
      return sql`
        SELECT
          cst.title,
          ${chatPreviewTitleOnlyMatch(tsQuery)},
          ${chatPreviewMessages(locatorTsQuery)}
        FROM chat_thread_search_documents cst
        JOIN chat_threads t ON t.id = cst.thread_id
        WHERE cst.thread_id = ${resultId}
          AND cst.preview_generation =
            ${CHAT_SEARCH_DISPLAY_METADATA_GENERATION}::uuid
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
          table: "document",
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
  database: Pick<typeof rootDb, "execute"> = rootDb,
): Promise<SearchPreview | null> => {
  if (input.type === "chat") {
    const rows = await database.execute<SearchPreviewChatRow>(
      buildSearchPreviewQuery(input),
    );
    const row = rows.at(0);
    if (!row || !Array.isArray(row.messages)) {
      return null;
    }

    if (row.isTitleOnlyMatch === true && typeof row.title === "string") {
      const title = row.title.trim();
      if (title) {
        return { type: "plain-text", content: title };
      }
    }

    const candidates: (SearchPreviewChatMessage & {
      isTarget: boolean;
      position: number;
    })[] = [];
    for (const [position, rawMessage] of row.messages.entries()) {
      if (!isSearchPreviewChatRole(rawMessage.role)) {
        continue;
      }
      const textParts = extractChatPreviewTextParts(rawMessage.content);
      if (textParts.length === 0) {
        continue;
      }
      candidates.push({
        content: textParts.join("\n\n"),
        id: rawMessage.id,
        isTarget: rawMessage.isTarget === true,
        position,
        role: rawMessage.role,
      });
    }

    const targetIndex = candidates.findIndex(({ isTarget }) => isTarget);
    const targetCandidate =
      targetIndex === -1 ? undefined : candidates.at(targetIndex);
    const orderedCandidates =
      targetCandidate === undefined
        ? candidates
        : [
            targetCandidate,
            ...Array.from({ length: candidates.length - 1 }).flatMap(
              (_, offset) => {
                const distance = offset + 1;
                const beforeIndex = targetIndex - distance;
                return [
                  beforeIndex < 0 ? undefined : candidates.at(beforeIndex),
                  candidates.at(targetIndex + distance),
                ].flatMap((candidate) => (candidate ? [candidate] : []));
              },
            ),
          ];

    const messages: (SearchPreviewChatMessage & { position: number })[] = [];
    const locatorCandidates = getSearchPreviewLocatorCandidates(input.query);
    let remainingCharacters = Math.max(
      0,
      LIMITS.searchPreviewResponseCharacterLimit,
    );
    for (const candidate of orderedCandidates) {
      if (remainingCharacters <= 0) {
        break;
      }
      const content = candidate.isTarget
        ? truncateSearchPreviewAroundCandidates({
            candidates: locatorCandidates,
            maxLength: remainingCharacters,
            source: candidate.content,
          })
        : candidate.content.slice(0, remainingCharacters);
      messages.push({
        content,
        id: candidate.id,
        position: candidate.position,
        role: candidate.role,
      });
      remainingCharacters -= content.length;
    }

    return {
      type: "chat-messages",
      messages: messages
        .toSorted((first, second) => first.position - second.position)
        .map(({ position: _, ...message }) => message),
    };
  }

  const rows = await database.execute(buildSearchPreviewQuery(input));
  const preview = rows.at(0)?.["preview"];
  if (!isSearchPreviewRow(preview)) {
    return null;
  }

  if (preview.sourceContent === null) {
    return { type: "plain-text", content: preview.content };
  }
  const content = restoreOriginalSearchPreview({
    headline: preview.content,
    maxLength: LIMITS.searchPreviewResponseCharacterLimit,
    normalizedSource: preview.normalizedSourceContent,
    source: preview.sourceContent,
    useUnaccent: preview.useUnaccent,
  });
  return { type: "highlighted-html", content: escapeAndHighlight(content) };
};
