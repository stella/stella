import { eq, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { chatThreads } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { timestampCasToken } from "@/api/lib/db/timestamp-cas";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import { CHAT_SEARCH_DISPLAY_METADATA_GENERATION } from "@/api/lib/search/chat-search-generation";
import { isRecord } from "@/api/lib/type-guards";

const BACKFILL_BATCH_SIZE = 200;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

type SearchablePersistedChatMessageContent = {
  data: unknown[];
  metadata?: unknown;
  version: 1 | 2 | 3;
};

const isPersistedChatMessageContent = (
  value: unknown,
): value is SearchablePersistedChatMessageContent =>
  isRecord(value) &&
  (value["version"] === 1 ||
    value["version"] === 2 ||
    value["version"] === 3) &&
  Array.isArray(value["data"]);

type SearchableChatTextPart = {
  content: string;
  type: "text";
};

type SearchableChatMessageMetadata = Record<string, unknown> & {
  sourceDocuments?: SearchableChatSourceDocument[] | undefined;
};

type NormalizedSearchableChatMessageContent = {
  metadata: SearchableChatMessageMetadata;
  parts: SearchableChatTextPart[];
};

/** `[label](href)` and `![alt](src)`, with the label captured. Neither class
 *  admits its own opening delimiter, which keeps the match linear in the
 *  subject (`super-linear-regexes` is a ratcheted metric, and this runs over
 *  whole persisted threads). The cost is that a label containing `[` or a
 *  target containing `(` is left alone; a chat mention href never has either,
 *  and an unstripped link is the safe direction to fail. */
const MARKDOWN_LINK_REGEX = /!?\[([^[\]]*)\]\([^()]*\)/gu;

/**
 * Drop link targets from persisted chat markdown, keeping the link label.
 *
 * Assistant text cites matters and entities as `[Name](#stella-workspace=<uuid>)`
 * (see `resolveAssistantTextRefs`), so the raw text carries an href for every
 * citation. Indexing it verbatim made the href both matchable and visible: a
 * search hit rendered its `ts_headline` inline, so the result row showed the
 * mention URL and could even highlight a fragment of the workspace UUID. The
 * label is the only part a reader searches for or wants to see.
 */
const stripMarkdownLinkTargets = (text: string): string =>
  text.replaceAll(MARKDOWN_LINK_REGEX, (_match, label: string) => label);

const toSearchableTextPart = (part: unknown): SearchableChatTextPart | null => {
  if (!isRecord(part) || part["type"] !== "text") {
    return null;
  }
  if (typeof part["content"] === "string") {
    return { type: "text", content: stripMarkdownLinkTargets(part["content"]) };
  }
  if (typeof part["text"] === "string") {
    return { type: "text", content: stripMarkdownLinkTargets(part["text"]) };
  }
  return null;
};

type SearchableChatSourceDocument = {
  entityId?: string;
  entityRef?: string;
  kind: string;
  matterRef?: string;
  mention?: string;
  mimeType?: string | null;
  title: string;
  workspaceId?: string | null;
};

const toSearchableChatSourceDocument = (
  value: unknown,
): SearchableChatSourceDocument | null => {
  if (
    !isRecord(value) ||
    typeof value["kind"] !== "string" ||
    typeof value["title"] !== "string"
  ) {
    return null;
  }
  return {
    kind: value["kind"],
    title: value["title"],
    ...(typeof value["entityId"] === "string"
      ? { entityId: value["entityId"] }
      : {}),
    ...(typeof value["entityRef"] === "string"
      ? { entityRef: value["entityRef"] }
      : {}),
    ...(typeof value["matterRef"] === "string"
      ? { matterRef: value["matterRef"] }
      : {}),
    ...(typeof value["mention"] === "string"
      ? { mention: value["mention"] }
      : {}),
    ...(value["mimeType"] === null || typeof value["mimeType"] === "string"
      ? { mimeType: value["mimeType"] }
      : {}),
    ...(value["workspaceId"] === null ||
    typeof value["workspaceId"] === "string"
      ? { workspaceId: value["workspaceId"] }
      : {}),
  };
};

export const normalizeSearchableChatMessageContent = (content: unknown) => {
  if (!isPersistedChatMessageContent(content)) {
    return null;
  }

  const parts = content.data.flatMap((part) => {
    const searchable = toSearchableTextPart(part);
    return searchable ? [searchable] : [];
  });
  const rawMetadata =
    content.version !== 1 && isRecord(content.metadata) ? content.metadata : {};
  const version2SourceDocuments = rawMetadata["sourceDocuments"];
  const legacySourceDocuments =
    content.version === 1
      ? content.data.flatMap((part) =>
          isRecord(part) &&
          part["type"] === "data-stella-source-document" &&
          isRecord(part["data"])
            ? [part["data"]]
            : [],
        )
      : [];
  let rawSourceDocuments = version2SourceDocuments;
  if (rawSourceDocuments === undefined && legacySourceDocuments.length > 0) {
    rawSourceDocuments = legacySourceDocuments;
  }
  const metadata: SearchableChatMessageMetadata = {
    ...rawMetadata,
    ...(rawSourceDocuments === undefined
      ? {}
      : {
          sourceDocuments: Array.isArray(rawSourceDocuments)
            ? rawSourceDocuments.flatMap((sourceDocument) => {
                const searchable =
                  toSearchableChatSourceDocument(sourceDocument);
                return searchable ? [searchable] : [];
              })
            : [],
        }),
  };

  return { metadata, parts } satisfies NormalizedSearchableChatMessageContent;
};

export const extractMessageSearchText = (
  content: SearchablePersistedChatMessageContent,
): string => {
  const parts: string[] = [];
  const message = normalizeSearchableChatMessageContent(content);
  if (!message) {
    return "";
  }
  for (const part of message.parts) {
    const trimmed = part.content.trim();
    if (trimmed) {
      parts.push(trimmed);
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
  content: SearchablePersistedChatMessageContent;
  createdAtToken: TimestampCasToken;
  id: SafeId<"chatMessage">;
  role: "assistant" | "system" | "user";
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
  database: Pick<typeof rootDb, "execute" | "select"> = rootDb,
): Promise<void> => {
  const [thread] = await database
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      updatedAtToken: timestampCasToken(chatThreads.updatedAt),
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);

  if (!thread) {
    return;
  }

  const searchableText = await rollUpThreadText({
    database,
    threadId: thread.id,
    threadUpdatedAtToken: thread.updatedAtToken,
  });
  await database.execute(sql`
    INSERT INTO chat_thread_search_documents (
      thread_id, title, searchable_text, preview_generation, updated_at, tsv
    ) VALUES (
      ${thread.id},
      ${thread.title},
      ${searchableText},
      NULL,
      ${thread.updatedAtToken}::timestamptz,
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
      preview_generation = NULL,
      updated_at = EXCLUDED.updated_at,
      tsv = EXCLUDED.tsv
    WHERE EXCLUDED.updated_at >= chat_thread_search_documents.updated_at
  `);
  await database.execute(sql`
    UPDATE chat_thread_search_documents
    SET preview_generation = ${CHAT_SEARCH_DISPLAY_METADATA_GENERATION}::uuid
    WHERE thread_id = ${thread.id}
      AND updated_at = ${thread.updatedAtToken}::timestamptz
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
  database,
  threadId,
  threadUpdatedAtToken,
}: {
  database: Pick<typeof rootDb, "execute">;
  threadId: SafeId<"chatThread">;
  threadUpdatedAtToken: TimestampCasToken;
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

    const page = await database.execute<ChatSearchMessageRow>(sql`
      SELECT id, role, content, created_at::text AS "createdAtToken"
      FROM chat_messages
      WHERE ${where}
      ORDER BY created_at, id
      LIMIT ${BACKFILL_BATCH_SIZE}
    `);

    if (page.length === 0) {
      break;
    }

    await upsertChatMessageSearchDocuments({
      database,
      messages: page,
      threadId,
      threadUpdatedAtToken,
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
  database,
  messages,
  threadId,
  threadUpdatedAtToken,
}: {
  database: Pick<typeof rootDb, "execute">;
  messages: readonly ChatSearchMessageRow[];
  threadId: SafeId<"chatThread">;
  threadUpdatedAtToken: TimestampCasToken;
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
      ${message.createdAtToken}::timestamptz,
      ${threadUpdatedAtToken}::timestamptz
    )`;
  });

  await database.execute(sql`
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

/** Periodic repair: index every thread with a missing or stale projection.
 *  Idempotent and resumable. Keyset-paginates by thread id so a thread that
 *  cannot be indexed (e.g. deleted mid-run) advances the cursor instead of
 *  looping. */
type BackfillChatThreadSearchIndexOptions = {
  signal?: AbortSignal;
  database?: Pick<typeof rootDb, "execute" | "select">;
};

export const backfillChatThreadSearchIndex = async ({
  signal,
  database = rootDb,
}: BackfillChatThreadSearchIndexOptions = {}): Promise<number> => {
  let cursor = ZERO_UUID;
  let total = 0;

  for (;;) {
    if (signal?.aborted) {
      return total;
    }
    // oxlint-disable-next-line require-search-scope/require-search-scope -- system backfill repairs derived search documents across all threads; it does not return request data
    const batch = await database.execute<{ id: SafeId<"chatThread"> }>(sql`
      SELECT t.id
      FROM chat_threads t
      LEFT JOIN chat_thread_search_documents d ON d.thread_id = t.id
      WHERE (
          d.thread_id IS NULL
          -- The previous writer stored UUIDv7 passage generations. The
          -- reserved display-metadata generation therefore distinguishes the
          -- current projection without rewriting existing rows in a migration.
          OR d.preview_generation IS DISTINCT FROM
            ${CHAT_SEARCH_DISPLAY_METADATA_GENERATION}::uuid
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
      if (signal?.aborted) {
        return total;
      }
      try {
        await upsertChatThreadSearchDocument(row.id, database);
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
