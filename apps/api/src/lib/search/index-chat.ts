import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { PersistedChatMessageContent } from "@/api/handlers/chat/types";
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
    for (const part of message.content.data) {
      if (part.type !== "text") {
        continue;
      }
      const trimmed = part.text.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
    }
  }
  return parts.join(" ").slice(0, LIMITS.chatSearchTextMaxLength);
};

/** Recompute the search document for one thread (title + rolled-up
 *  message text). Tenancy is not stored here; the global-search query
 *  derives it by joining back to `chat_threads`. Safe to call after
 *  any thread mutation; a missing thread is a no-op. */
export const upsertChatThreadSearchDocument = async (
  threadId: SafeId<"chatThread">,
): Promise<void> => {
  const thread = await rootDb.query.chatThreads.findFirst({
    where: { id: { eq: threadId } },
    columns: { id: true, title: true, updatedAt: true },
    with: {
      messages: {
        columns: { content: true },
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
  `);
};

/** One-time backfill: index every thread that has no search document
 *  yet. Idempotent and resumable. Keyset-paginates by thread id so a
 *  thread that cannot be indexed (e.g. deleted mid-run) advances the
 *  cursor instead of looping. */
export const backfillChatThreadSearchIndex = async (): Promise<number> => {
  let cursor = ZERO_UUID;
  let total = 0;

  for (;;) {
    const batch = await rootDb.execute<{ id: SafeId<"chatThread"> }>(sql`
      SELECT t.id
      FROM chat_threads t
      LEFT JOIN chat_thread_search_documents d ON d.thread_id = t.id
      WHERE d.thread_id IS NULL
        AND t.id > ${cursor}::uuid
      ORDER BY t.id
      LIMIT ${BACKFILL_BATCH_SIZE}
    `);

    const last = batch.at(-1);
    if (!last) {
      break;
    }

    for (const row of batch) {
      await upsertChatThreadSearchDocument(row.id);
    }

    cursor = String(last.id);
    total += batch.length;
    logger.info("chat_search.backfill_progress", { indexed: total });
  }

  return total;
};
