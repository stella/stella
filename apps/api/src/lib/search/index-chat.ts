import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type {
  ChatMessageRole,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

const BACKFILL_BATCH_SIZE = 200;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** The plain searchable text of a thread: the prose of every `text`
 *  part across all messages, in order, from both the user and the
 *  assistant. Tool-call, reasoning, and data parts carry no
 *  user-meaningful prose and are skipped. Capped so a long
 *  conversation cannot bloat the stored tsv. */
const extractThreadText = (
  messages: readonly { content: PersistedChatMessageContent }[],
): string => {
  const parts: string[] = [];
  for (const message of messages) {
    const messageText = extractMessageSearchText(message.content);
    if (messageText) {
      parts.push(messageText);
    }
  }
  return parts.join(" ").slice(0, LIMITS.chatSearchTextMaxLength);
};

const extractMessageSearchText = (
  content: PersistedChatMessageContent,
): string => {
  const parts: string[] = [];
  const messageParts: readonly unknown[] = content.data;
  for (const part of messageParts) {
    if (!isRecord(part) || typeof part["type"] !== "string") {
      continue;
    }

    if (part["type"] === "text" && typeof part["text"] === "string") {
      const trimmed = part["text"].trim();
      if (trimmed) {
        parts.push(trimmed);
      }
      continue;
    }

    const sourceDocumentData = part["data"];
    if (
      part["type"] === "data-stella-source-document" &&
      isRecord(sourceDocumentData)
    ) {
      for (const value of [
        sourceDocumentData["title"],
        sourceDocumentData["mention"],
        sourceDocumentData["entityRef"],
        sourceDocumentData["matterRef"],
        sourceDocumentData["kind"],
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
  }

  return parts.join(" ").slice(0, LIMITS.chatMessageSearchTextMaxLength);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

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
 *  to call after any thread mutation; a missing thread is a no-op. */
export const upsertChatThreadSearchDocument = async (
  threadId: SafeId<"chatThread">,
): Promise<void> => {
  const thread = await rootDb.query.chatThreads.findFirst({
    where: { id: { eq: threadId } },
    columns: { id: true, title: true, updatedAt: true },
    with: {
      messages: {
        columns: {
          id: true,
          role: true,
          content: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!thread) {
    return;
  }

  const searchableText = extractThreadText(thread.messages);

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
          coalesce(${thread.title}, '') || ' ' ||
          coalesce(${searchableText}, '')
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

  await upsertChatMessageSearchDocuments({
    messages: thread.messages,
    threadId: thread.id,
    threadUpdatedAt: thread.updatedAt,
  });
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
      to_tsvector('simple', unaccent(coalesce(${searchableText}, ''))),
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
