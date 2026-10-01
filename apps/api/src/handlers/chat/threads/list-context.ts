import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { isEntityKind } from "@stll/api-contract";
import type { EntityKind } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Most matters and most files one thread's context names in a list page.
 * Counts beyond it are still reported, so the history can say "+N".
 */
export const CHAT_THREAD_CONTEXT_PREVIEW_LIMIT = 8;
/** Most recent user messages per thread read for mentions. */
export const CHAT_THREAD_CONTEXT_MESSAGE_SCAN_LIMIT = 25;
/** Most recent uploaded attachments per thread read. */
export const CHAT_THREAD_CONTEXT_ATTACHMENT_SCAN_LIMIT = 25;
/** Most pinned and most data matter ids per thread read from its arrays. */
export const CHAT_THREAD_CONTEXT_MATTER_SCAN_LIMIT = 50;

export type ChatThreadContextMatter = {
  color: string | null;
  id: string;
  name: string;
};

export type ChatThreadContextFile = {
  id: string;
  kind: EntityKind;
  mimeType: string | null;
  name: string;
};

/**
 * The matters and files one thread drew on, as a bounded preview: at most
 * `CHAT_THREAD_CONTEXT_PREVIEW_LIMIT` of each, in display order, beside the
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

type ChatThreadContextRow = {
  color: string | null;
  itemId: string;
  itemType: "file" | "matter";
  kind: string | null;
  mimeType: string | null;
  name: string;
  threadId: string;
  total: number;
};

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

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
  isNullableString(value["kind"]) &&
  isNullableString(value["mimeType"]);

const UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/** The one statement behind `readChatThreadContexts`. */
const chatThreadContextsQuery = (threadIds: readonly string[]): SQL => sql`
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
    mention_refs AS (
      SELECT
        recent.thread_id,
        recent.created_at,
        mention.value->>'category' AS category,
        CASE
          WHEN mention.value->>'id' ~* ${UUID_PATTERN}
          THEN (mention.value->>'id')::uuid
        END AS ref_id,
        row_number() OVER (
          PARTITION BY recent.thread_id
          ORDER BY recent.created_at DESC, mention.ordinality
        ) AS ord
      FROM (
        SELECT pt.thread_id, m.content, m.created_at
        FROM page_threads pt
        CROSS JOIN LATERAL (
          SELECT content, created_at
          FROM chat_messages
          WHERE thread_id = pt.thread_id AND role = 'user'
          ORDER BY created_at DESC
          LIMIT ${CHAT_THREAD_CONTEXT_MESSAGE_SCAN_LIMIT}
        ) m
      ) recent
      CROSS JOIN LATERAL jsonb_path_query(
        recent.content,
        '$.metadata.mentions.mentions[*]'
      ) WITH ORDINALITY AS mention(value, ordinality)
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
        te.sort_at
      FROM thread_entities te
      JOIN entities e ON e.id = te.entity_id
      UNION ALL
      SELECT
        pt.thread_id,
        uf.id::text,
        uf.file_name,
        'document',
        uf.mime_type,
        uf.created_at
      FROM page_threads pt
      CROSS JOIN LATERAL (
        SELECT id, file_name, mime_type, created_at
        FROM user_files
        WHERE thread_id = pt.thread_id
        ORDER BY created_at DESC
        LIMIT ${CHAT_THREAD_CONTEXT_ATTACHMENT_SCAN_LIMIT}
      ) uf
    ),
    ranked_files AS (
      SELECT
        thread_id,
        item_id,
        name,
        kind,
        mime_type,
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
      rank::int AS rank
    FROM ranked_matters
    WHERE rank <= ${CHAT_THREAD_CONTEXT_PREVIEW_LIMIT}
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
      rank::int
    FROM ranked_files
    WHERE rank <= ${CHAT_THREAD_CONTEXT_PREVIEW_LIMIT}
    ORDER BY 1, 2, 9
`;

/**
 * Reads the context of a page of threads in one statement, never per row.
 *
 * Matters, in order: the matter the thread lives in, the matters pinned to it
 * (`context_matter_ids`), matters mentioned in its recent user messages, then
 * matters whose data it embedded (`data_workspace_ids`).
 *
 * Files, in order: the document a file chat is bound to, then documents
 * mentioned in recent user messages and files uploaded into the thread,
 * newest first.
 *
 * Every read is bounded per thread (see the scan limits above). Matters and
 * documents resolve through the caller's RLS-scoped transaction, so a matter
 * or document the user can no longer open is neither shown nor counted.
 */
export const readChatThreadContexts = async ({
  threadIds,
  tx,
}: {
  threadIds: readonly string[];
  tx: Pick<Transaction, "execute">;
}): Promise<Map<string, ChatThreadContext>> => {
  const contexts = new Map<string, ChatThreadContext>();
  if (threadIds.length === 0) {
    return contexts;
  }

  const result = await tx.execute(chatThreadContextsQuery(threadIds));

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
    // A kind outside the closed set is a row this build cannot draw; it is
    // left out of the preview but stays in the count.
    if (isEntityKind(row.kind)) {
      context.files.push({
        id: row.itemId,
        kind: row.kind,
        mimeType: row.mimeType,
        name: row.name,
      });
    }
    context.fileCount = Math.max(total, context.files.length);
  }

  return contexts;
};
