import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  CHAT_MENTION_UUID_HREF_PATTERN,
  isEntityKind,
} from "@stll/api-contract";
import type { EntityKind } from "@stll/api-contract";
import { USER_FILE_URL_PREFIX } from "@stll/api-contract/user-file-url";

import type { Transaction } from "@/api/db/root";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Most matters and most files one thread's context names in a list page.
 * Counts beyond it are still reported, so the history can say "+N".
 */
export const CHAT_THREAD_CONTEXT_PREVIEW_LIMIT = 8;
/**
 * Most files an open thread names. Higher than the list preview because the
 * open thread lists every file it attached; the message scan limit below
 * bounds the candidates either way.
 */
const CHAT_THREAD_OPEN_FILES_LIMIT = 50;
/** Most recent user messages per thread read for mentions and uploads. */
const CHAT_THREAD_CONTEXT_MESSAGE_SCAN_LIMIT = 25;
/** Most pinned and most data matter ids per thread read from its arrays. */
export const CHAT_THREAD_CONTEXT_MATTER_SCAN_LIMIT = 50;

type ChatThreadContextMatter = {
  color: string | null;
  id: string;
  name: string;
};

/** Where a thread's file comes from, which decides how it opens. */
const CHAT_THREAD_FILE_TYPE = {
  /** A matter document the thread is bound to or a user message mentioned. */
  entity: "entity",
  /** A file uploaded to a user message, served from the user-file store. */
  upload: "upload",
} as const;

type ChatThreadContextFile =
  | {
      id: string;
      kind: EntityKind;
      /** The matter the document lives in, where it opens. */
      matterId: string;
      mimeType: null;
      name: string;
      type: typeof CHAT_THREAD_FILE_TYPE.entity;
    }
  | {
      id: string;
      kind: "document";
      mimeType: string;
      name: string;
      type: typeof CHAT_THREAD_FILE_TYPE.upload;
    };

/**
 * The matters and files one thread drew on, as a bounded preview: at most
 * the reader's preview limit of each, in display order, beside the
 * number the scan found. A count can exceed the preview, never the reverse.
 */
export type ChatThreadContext = {
  fileCount: number;
  files: ChatThreadContextFile[];
  matterCount: number;
  matters: ChatThreadContextMatter[];
};

export const EMPTY_CHAT_THREAD_CONTEXT: ChatThreadContext = {
  fileCount: 0,
  files: [],
  matterCount: 0,
  matters: [],
};

type ChatThreadFileType =
  (typeof CHAT_THREAD_FILE_TYPE)[keyof typeof CHAT_THREAD_FILE_TYPE];

type ChatThreadContextRow = {
  color: string | null;
  fileType: ChatThreadFileType | null;
  itemId: string;
  itemType: "file" | "matter";
  kind: string | null;
  matterId: string | null;
  mimeType: string | null;
  name: string;
  threadId: string;
  total: number;
};

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isChatThreadFileType = (value: unknown): value is ChatThreadFileType =>
  value === CHAT_THREAD_FILE_TYPE.entity ||
  value === CHAT_THREAD_FILE_TYPE.upload;

const isChatThreadContextRow = (
  value: unknown,
): value is ChatThreadContextRow =>
  isRecord(value) &&
  typeof value["threadId"] === "string" &&
  (value["itemType"] === "file" || value["itemType"] === "matter") &&
  typeof value["itemId"] === "string" &&
  typeof value["name"] === "string" &&
  typeof value["total"] === "number" &&
  isNullableString(value["color"]) &&
  (value["fileType"] === null || isChatThreadFileType(value["fileType"])) &&
  isNullableString(value["kind"]) &&
  isNullableString(value["matterId"]) &&
  isNullableString(value["mimeType"]);

const UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/**
 * Every mention a thread's recent user messages carry, per message in order.
 * Versions 2 and 3 keep mentions in metadata; version 1 kept them as
 * data-stella-mentions parts; the composer's mention chips persist only as
 * mention links in the text.
 */
const mentionValuesQuery = sql`
  SELECT
    recent.thread_id,
    recent.created_at,
    mention.value->>'category' AS category,
    mention.value->>'id' AS raw_id,
    mention.ordinality AS position
  FROM recent_user_messages recent
  CROSS JOIN LATERAL jsonb_array_elements(
    jsonb_path_query_array(
      recent.content,
      '$.metadata.mentions.mentions[*]'
    ) || jsonb_path_query_array(
      recent.content,
      '$.data[*] ? (@.type == "data-stella-mentions").data.mentions[*]'
    )
  ) WITH ORDINALITY AS mention(value, ordinality)
  UNION ALL
  SELECT
    recent.thread_id,
    recent.created_at,
    CASE WHEN link.groups[1] IS NOT NULL THEN 'entity' ELSE 'workspace' END,
    COALESCE(link.groups[1], link.groups[2]),
    link.ordinality
  FROM recent_user_messages recent
  CROSS JOIN LATERAL jsonb_array_elements_text(
    jsonb_path_query_array(
      recent.content,
      '$.data[*] ? (@.type == "text").content ? (@.type() == "string")'
    )
  ) AS text_part(content)
  CROSS JOIN LATERAL regexp_matches(
    text_part.content,
    ${CHAT_MENTION_UUID_HREF_PATTERN}::text,
    'g'
  ) WITH ORDINALITY AS link(groups, ordinality)
`;

/**
 * Uploads the surviving messages still reference: image and document parts
 * (versions 2 and 3) and legacy file parts (version 1). An upload whose
 * message was edited away or truncated is not context any more.
 */
const attachmentRefsQuery = sql`
  SELECT
    recent.thread_id,
    recent.created_at,
    CASE
      WHEN starts_with(ref.url, ${USER_FILE_URL_PREFIX})
        AND substring(ref.url FROM ${USER_FILE_URL_PREFIX.length + 1}::int) ~* ${UUID_PATTERN}
      THEN substring(ref.url FROM ${USER_FILE_URL_PREFIX.length + 1}::int)::uuid
    END AS file_id
  FROM recent_user_messages recent
  CROSS JOIN LATERAL jsonb_array_elements_text(
    jsonb_path_query_array(
      recent.content,
      '$.data[*] ? (@.type == "image" || @.type == "document").source.value ? (@.type() == "string")'
    ) || jsonb_path_query_array(
      recent.content,
      '$.data[*] ? (@.type == "file").url ? (@.type() == "string")'
    )
  ) AS ref(url)
`;

/** The one statement behind `readChatThreadContexts`. */
const chatThreadContextsQuery = ({
  previewLimit,
  threadIds,
}: {
  previewLimit: number;
  threadIds: readonly string[];
}): SQL => sql`
    WITH page_threads AS (
      SELECT
        t.id AS thread_id,
        t.workspace_id,
        t.context_matter_ids[1:${CHAT_THREAD_CONTEXT_MATTER_SCAN_LIMIT}::int] AS pinned_ids,
        t.data_workspace_ids[1:${CHAT_THREAD_CONTEXT_MATTER_SCAN_LIMIT}::int] AS data_ids
      FROM chat_threads t
      WHERE t.id IN (
        SELECT value::uuid
        FROM jsonb_array_elements_text(${JSON.stringify(threadIds)}::text::jsonb)
      )
    ),
    recent_user_messages AS (
      SELECT pt.thread_id, m.content, m.created_at
      FROM page_threads pt
      CROSS JOIN LATERAL (
        SELECT content, created_at
        FROM chat_messages
        WHERE thread_id = pt.thread_id AND role = 'user'
        ORDER BY created_at DESC
        LIMIT ${CHAT_THREAD_CONTEXT_MESSAGE_SCAN_LIMIT}
      ) m
    ),
    mention_values AS (
      ${mentionValuesQuery}
    ),
    mention_refs AS (
      SELECT
        thread_id,
        created_at,
        category,
        CASE WHEN raw_id ~* ${UUID_PATTERN} THEN raw_id::uuid END AS ref_id,
        row_number() OVER (
          PARTITION BY thread_id
          ORDER BY created_at DESC, position
        ) AS ord
      FROM mention_values
    ),
    attachment_refs AS (
      ${attachmentRefsQuery}
    ),
    thread_attachments AS (
      SELECT DISTINCT ON (thread_id, file_id) thread_id, file_id, created_at
      FROM attachment_refs
      WHERE file_id IS NOT NULL
      ORDER BY thread_id, file_id, created_at DESC
    ),
    matter_candidates AS (
      SELECT thread_id, workspace_id AS matter_id, 0 AS priority, 0::bigint AS ord
      FROM page_threads
      WHERE workspace_id IS NOT NULL
      UNION ALL
      SELECT pt.thread_id, pinned.matter_id, 1, pinned.ord
      FROM page_threads pt
      CROSS JOIN LATERAL unnest(pt.pinned_ids) WITH ORDINALITY AS pinned(matter_id, ord)
      UNION ALL
      SELECT thread_id, ref_id, 2, ord
      FROM mention_refs
      WHERE category = 'workspace' AND ref_id IS NOT NULL
      UNION ALL
      SELECT pt.thread_id, embedded.matter_id, 3, embedded.ord
      FROM page_threads pt
      CROSS JOIN LATERAL unnest(pt.data_ids) WITH ORDINALITY AS embedded(matter_id, ord)
    ),
    thread_matters AS (
      SELECT DISTINCT ON (thread_id, matter_id) thread_id, matter_id, priority, ord
      FROM matter_candidates
      ORDER BY thread_id, matter_id, priority, ord
    ),
    ranked_matters AS (
      SELECT
        tm.thread_id,
        w.id::text AS item_id,
        w.name,
        w.color,
        row_number() OVER (
          PARTITION BY tm.thread_id ORDER BY tm.priority, tm.ord, w.id
        ) AS rank,
        count(*) OVER (PARTITION BY tm.thread_id) AS total
      FROM thread_matters tm
      JOIN workspaces w ON w.id = tm.matter_id AND w.status <> 'deleting'
    ),
    -- The document a file chat is bound to sorts first ('infinity'); every
    -- other file sorts by when the thread last referenced it.
    entity_candidates AS (
      SELECT
        fct.chat_thread_id AS thread_id,
        fct.entity_id,
        'infinity'::timestamptz AS sort_at
      FROM file_chat_threads fct
      WHERE fct.chat_thread_id IN (SELECT thread_id FROM page_threads)
      UNION ALL
      SELECT thread_id, ref_id, created_at
      FROM mention_refs
      WHERE category = 'entity' AND ref_id IS NOT NULL
    ),
    thread_entities AS (
      SELECT DISTINCT ON (thread_id, entity_id) thread_id, entity_id, sort_at
      FROM entity_candidates
      ORDER BY thread_id, entity_id, sort_at DESC
    ),
    file_candidates AS (
      SELECT
        te.thread_id,
        e.id::text AS item_id,
        COALESCE(NULLIF(e.name, ''), e.display_name) AS name,
        e.kind,
        NULL::text AS mime_type,
        ${CHAT_THREAD_FILE_TYPE.entity}::text AS file_type,
        e.workspace_id::text AS matter_id,
        te.sort_at
      FROM thread_entities te
      JOIN entities e ON e.id = te.entity_id
      UNION ALL
      SELECT
        ta.thread_id,
        uf.id::text,
        uf.file_name,
        'document',
        uf.mime_type,
        ${CHAT_THREAD_FILE_TYPE.upload}::text,
        NULL::text,
        ta.created_at
      FROM thread_attachments ta
      JOIN user_files uf ON uf.id = ta.file_id AND uf.thread_id = ta.thread_id
    ),
    ranked_files AS (
      SELECT
        thread_id,
        item_id,
        name,
        kind,
        mime_type,
        file_type,
        matter_id,
        row_number() OVER (
          PARTITION BY thread_id ORDER BY sort_at DESC, item_id
        ) AS rank,
        count(*) OVER (PARTITION BY thread_id) AS total
      FROM file_candidates
    )
    SELECT
      thread_id::text AS "threadId",
      'matter' AS "itemType",
      item_id AS "itemId",
      name,
      color,
      NULL::text AS kind,
      NULL::text AS "mimeType",
      total::int AS total,
      rank::int AS rank,
      NULL::text AS "fileType",
      NULL::text AS "matterId"
    FROM ranked_matters
    WHERE rank <= ${previewLimit}
    UNION ALL
    SELECT
      thread_id::text,
      'file',
      item_id,
      name,
      NULL::text,
      kind,
      mime_type,
      total::int,
      rank::int,
      file_type,
      matter_id
    FROM ranked_files
    WHERE rank <= ${previewLimit}
    ORDER BY 1, 2, 9
`;

const toContextFile = (
  row: ChatThreadContextRow,
): ChatThreadContextFile | null => {
  switch (row.fileType) {
    case null:
      return panic("A chat thread file row has no file type");
    case CHAT_THREAD_FILE_TYPE.upload:
      return {
        id: row.itemId,
        kind: "document",
        mimeType:
          row.mimeType ?? panic("An uploaded chat file has no mime type"),
        name: row.name,
        type: CHAT_THREAD_FILE_TYPE.upload,
      };
    case CHAT_THREAD_FILE_TYPE.entity:
      // A kind outside the closed set is a row this build cannot draw; it is
      // left out of the preview but stays in the count.
      if (!isEntityKind(row.kind)) {
        return null;
      }
      return {
        id: row.itemId,
        kind: row.kind,
        matterId: row.matterId ?? panic("A chat file document has no matter"),
        mimeType: null,
        name: row.name,
        type: CHAT_THREAD_FILE_TYPE.entity,
      };
    default: {
      row.fileType satisfies never;
      return panic("Unhandled chat thread file type");
    }
  }
};

/**
 * Reads the context of a page of threads in one statement, never per row.
 *
 * Matters, in order: the matter the thread lives in, the matters pinned to it
 * (`context_matter_ids`), matters mentioned in its recent user messages, then
 * matters whose data it embedded (`data_workspace_ids`).
 *
 * Files, in order: the document a file chat is bound to, then documents
 * mentioned in recent user messages and uploads those messages still attach,
 * newest first. Mentions and uploads are read from every persisted message
 * version.
 *
 * Every read is bounded per thread (see the scan limits above). Matters and
 * documents resolve through the caller's RLS-scoped transaction, so a matter
 * or document the user can no longer open is neither shown nor counted.
 */
export const readChatThreadContexts = async ({
  previewLimit,
  threadIds,
  tx,
}: {
  /** Most matters and most files named per thread; counts go beyond it. */
  previewLimit: number;
  threadIds: readonly string[];
  tx: Pick<Transaction, "execute">;
}): Promise<Map<string, ChatThreadContext>> => {
  const contexts = new Map<string, ChatThreadContext>();
  if (threadIds.length === 0) {
    return contexts;
  }

  const result = await tx.execute(
    chatThreadContextsQuery({ previewLimit, threadIds }),
  );

  for (const row of executedRows(result)) {
    if (!isChatThreadContextRow(row)) {
      return panic("Chat thread context row has an unexpected shape");
    }
    const context = contexts.get(row.threadId) ?? {
      fileCount: 0,
      files: [],
      matterCount: 0,
      matters: [],
    };
    contexts.set(row.threadId, context);
    const total = row.total;
    if (row.itemType === "matter") {
      context.matters.push({
        color: row.color,
        id: row.itemId,
        name: row.name,
      });
      context.matterCount = Math.max(total, context.matters.length);
      continue;
    }
    const file = toContextFile(row);
    if (file !== null) {
      context.files.push(file);
    }
    context.fileCount = Math.max(total, context.files.length);
  }

  return contexts;
};

/** The files one open thread attached, beside the number the scan found. */
export type ChatThreadAttachedFiles = Pick<
  ChatThreadContext,
  "fileCount" | "files"
>;

export const EMPTY_CHAT_THREAD_ATTACHED_FILES: ChatThreadAttachedFiles = {
  fileCount: 0,
  files: [],
};

/**
 * The files an open thread attached, by the same definition and RLS scope as
 * the history list's context, so the thread header and its history row cannot
 * disagree. Read from the server rather than the loaded transcript, because
 * older messages page in on demand.
 */
export const readChatThreadAttachedFiles = async ({
  threadId,
  tx,
}: {
  threadId: string;
  tx: Pick<Transaction, "execute">;
}): Promise<ChatThreadAttachedFiles> => {
  const contexts = await readChatThreadContexts({
    previewLimit: CHAT_THREAD_OPEN_FILES_LIMIT,
    threadIds: [threadId],
    tx,
  });
  const context = contexts.get(threadId);
  if (context === undefined) {
    return EMPTY_CHAT_THREAD_ATTACHED_FILES;
  }
  return { fileCount: context.fileCount, files: context.files };
};
