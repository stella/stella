import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { normalizePersistedChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import type {
  ChatMessageRole,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

const BACKFILL_BATCH_SIZE = 200;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

const extractMessageSearchText = (
  content: PersistedChatMessageContent,
): string => {
  const parts: string[] = [];
  const message = normalizePersistedChatMessageContent(content);
  for (const part of message.parts) {
    if (part.type === "text") {
      const trimmed = part.content.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
    }
  }

  const sourceDocuments = message.metadata.sourceDocuments;
  if (!sourceDocuments) {
    return parts.join(" ");
  }
  for (const sourceDocumentData of sourceDocuments) {
    for (const value of [
      sourceDocumentData.title,
      sourceDocumentData.mention,
      sourceDocumentData.entityRef,
      sourceDocumentData.matterRef,
      sourceDocumentData.kind,
    ]) {
      if (typeof value !== "string") {
        continue;
      }

      const trimmed = value.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
    }
  }

  return parts.join(" ").slice(0, LIMITS.chatMessageSearchTextMaxLength);
};

type ChatSearchMessageRow = {
  content: PersistedChatMessageContent;
  createdAt: Date;
  id: SafeId<"chatMessage">;
  role: ChatMessageRole;
};

/** Recompute the search document for one thread (title + rolled-up
 *  message text) plus the per-message history search documents.
 *  Tenancy is not stored here; search queries derive it by joining
 *  back to `chat_threads` or through RLS on the owning thread. Safe
 *  to call after any thread mutation; a missing thread is a no-op.
 *
 *  Messages are keyset-paginated by `(created_at, id)` in bounded
 *  pages rather than eager-loaded in one shot: a long thread that is
 *  re-indexed after every message persist must not re-read its whole
 *  history into memory on each send. The rolled-up thread text is
 *  accumulated page by page and stops growing once the thread text cap
 *  is reached, so the stored thread tsv/text is byte-identical to the
 *  previous full-history build for any thread under the cap. Per-message
 *  search documents are still written for every page (all messages stay
 *  individually searchable), so paging continues past the thread-text
 *  cap. This is a background derived-document refresh after a thread
 *  mutation, not on the request hot path. */
export const upsertChatThreadSearchDocument = async (
  threadId: SafeId<"chatThread">,
): Promise<void> => {
  const thread = await rootDb.query.chatThreads.findFirst({
    where: { id: { eq: threadId } },
    columns: { id: true, title: true, updatedAt: true },
  });

  if (!thread) {
    return;
  }

  const searchableText = await rollUpThreadText({
    threadId: thread.id,
    threadUpdatedAt: thread.updatedAt,
  });

  await rootDb.execute(sql`
    INSERT INTO chat_thread_search_documents (
      thread_id, title, searchable_text, updated_at, tsv
    ) VALUES (
      ${thread.id},
      ${thread.title},
      ${searchableText},
      ${thread.updatedAt},
      to_tsvector(
        'simple',
        unaccent(
          arabic_normalize(
            coalesce(${thread.title}, '') || ' ' ||
            coalesce(${searchableText}, '')
          )
        )
      )
    )
    ON CONFLICT (thread_id) DO UPDATE SET
      title = EXCLUDED.title,
      searchable_text = EXCLUDED.searchable_text,
      updated_at = EXCLUDED.updated_at,
      tsv = EXCLUDED.tsv
    WHERE EXCLUDED.updated_at >= chat_thread_search_documents.updated_at
  `);
};

/** Page through a thread's messages by `(created_at, id)`, write the
 *  per-message search documents for each page, and accumulate the
 *  rolled-up thread text: the prose of every `text` part across all
 *  messages, in order, from both the user and the assistant (tool-call,
 *  reasoning, and data parts carry no user-meaningful prose and are
 *  skipped). The returned text is byte-identical to a full-history build
 *  for any thread whose rolled-up text is at or under
 *  `chatSearchTextMaxLength`: parts are joined with a single space in
 *  `(created_at, id)` order and the same cap is applied. Once the cap is
 *  reached we stop accumulating thread text (further messages cannot
 *  change a `slice(0, cap)` result) but keep paging so every message
 *  still gets a per-message search document.
 *
 *  Note: the previous build ordered messages by `created_at` only, with
 *  no tiebreaker, so the relative order of same-timestamp messages was
 *  database-defined (undefined). Adding `id` as a deterministic
 *  tiebreaker only makes that order stable; there is no defined prior
 *  order to diverge from. */
const rollUpThreadText = async ({
  threadId,
  threadUpdatedAt,
}: {
  threadId: SafeId<"chatThread">;
  threadUpdatedAt: Date;
}): Promise<string> => {
  const textParts: string[] = [];
  let accumulatedLength = 0;
  let threadTextFull = false;
  // Id-only cursor resolved in-DB: comparing against the boundary row's exact
  // (created_at, id) avoids round-tripping created_at through a JS Date, which
  // would truncate Postgres microseconds and could re-read or stall on a page
  // of same-millisecond rows.
  let cursor: SafeId<"chatMessage"> | undefined;

  for (;;) {
    const where = cursor
      ? sql`thread_id = ${threadId}
          AND (created_at, id) > (select created_at, id from chat_messages where id = ${cursor})`
      : sql`thread_id = ${threadId}`;

    // eslint-disable-next-line no-await-in-loop -- sequential keyset pagination: each page's WHERE depends on the previous page's last (created_at, id) cursor.
    const page = await rootDb.execute<ChatSearchMessageRow>(sql`
      SELECT id, role, content, created_at AS "createdAt"
      FROM chat_messages
      WHERE ${where}
      ORDER BY created_at, id
      LIMIT ${BACKFILL_BATCH_SIZE}
    `);

    if (page.length === 0) {
      break;
    }

    // eslint-disable-next-line no-await-in-loop -- sequential keyset pagination: per-page writes are ordered with the cursor advance above.
    await upsertChatMessageSearchDocuments({
      messages: page,
      threadId,
      threadUpdatedAt,
    });

    for (const message of page) {
      if (threadTextFull) {
        break;
      }

      const messageText = extractMessageSearchText(message.content);
      if (!messageText) {
        continue;
      }

      textParts.push(messageText);
      // +1 per part beyond the first accounts for the single-space join.
      accumulatedLength += messageText.length + (textParts.length > 1 ? 1 : 0);
      if (accumulatedLength >= LIMITS.chatSearchTextMaxLength) {
        threadTextFull = true;
      }
    }

    const last = page.at(-1);
    if (!last || page.length < BACKFILL_BATCH_SIZE) {
      break;
    }
    cursor = last.id;
  }

  return textParts.join(" ").slice(0, LIMITS.chatSearchTextMaxLength);
};

const upsertChatMessageSearchDocuments = async ({
  messages,
  threadId,
  threadUpdatedAt,
}: {
  messages: readonly ChatSearchMessageRow[];
  threadId: SafeId<"chatThread">;
  threadUpdatedAt: Date;
}): Promise<void> => {
  if (messages.length === 0) {
    return;
  }

  const values = messages.map((message) => {
    const searchableText = extractMessageSearchText(message.content);
    return sql`(
      ${message.id},
      ${threadId},
      ${message.role},
      ${searchableText},
      to_tsvector('simple', unaccent(arabic_normalize(coalesce(${searchableText}, '')))),
      ${message.createdAt},
      ${threadUpdatedAt}
    )`;
  });

  await rootDb.execute(sql`
    INSERT INTO chat_message_search_documents (
      message_id, thread_id, role, searchable_text, tsv, created_at, updated_at
    ) VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (message_id) DO UPDATE SET
      thread_id = EXCLUDED.thread_id,
      role = EXCLUDED.role,
      searchable_text = EXCLUDED.searchable_text,
      tsv = EXCLUDED.tsv,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at
    WHERE EXCLUDED.updated_at >= chat_message_search_documents.updated_at
  `);
};

/** One-time backfill: index every thread missing either a thread-level
 *  search document or per-message search documents. Idempotent and
 *  resumable. Keyset-paginates by thread id so a thread that cannot
 *  be indexed (e.g. deleted mid-run) advances the cursor instead of
 *  looping. */
export const backfillChatThreadSearchIndex = async (): Promise<number> => {
  let cursor = ZERO_UUID;
  let total = 0;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- keyset pagination: each batch depends on the previous cursor
    const batch = await rootDb.execute<{ id: SafeId<"chatThread"> }>(sql`
      SELECT t.id
      FROM chat_threads t
      LEFT JOIN chat_thread_search_documents d ON d.thread_id = t.id
      WHERE (
          d.thread_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM chat_messages m
            LEFT JOIN chat_message_search_documents md
              ON md.message_id = m.id
            WHERE m.thread_id = t.id
              AND md.message_id IS NULL
          )
        )
        AND t.id > ${cursor}::uuid
      ORDER BY t.id
      LIMIT ${BACKFILL_BATCH_SIZE}
    `);

    const last = batch.at(-1);
    if (!last) {
      break;
    }

    for (const row of batch) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential by design: sequential per-thread backfill writes bound DB load
        await upsertChatThreadSearchDocument(row.id);
      } catch (error) {
        captureError(error, {
          feature: "chat_search.backfill",
          threadId: row.id,
        });
        logger.error("chat_search.backfill_failed", { threadId: row.id });
      }
    }

    cursor = String(last.id);
    total += batch.length;
    logger.info("chat_search.backfill_progress", { indexed: total });
  }

  return total;
};
