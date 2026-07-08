import type { Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";

import type { SafeDbError, SafeDbOrTx, Transaction } from "@/api/db";
import { withScopedTx } from "@/api/db";
import { chatMessages } from "@/api/db/schema";
import {
  chatMessageFromPersisted,
  getChatAttachmentUrl,
  isChatAttachmentPart,
  normalizePersistedChatMessageContent,
} from "@/api/handlers/chat/chat-message-parts";
import type {
  ChatMessageMetadata,
  ChatMessageRole,
  ChatPart,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import { parseUserFileId } from "@/api/handlers/user-files/types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedChatMessageId } from "@/api/lib/safe-id-boundaries";

export type ClientMessage = {
  id: SafeId<"chatMessage">;
  metadata?: ChatMessageMetadata | undefined;
  role: ChatMessageRole;
  parts: ChatPart[];
};

/**
 * Attach the stored blur placeholder to image file parts so the client can
 * render a blur-up while the thumbnail loads. The thumbnail URL itself is
 * derived client-side from the user-file id, so only the DB-sourced
 * placeholder needs to travel with the message.
 */
export const attachPlaceholders = (
  parts: ChatPart[],
  placeholderById: Map<string, string>,
): ChatPart[] =>
  parts.map((part) => {
    if (!isChatAttachmentPart(part)) {
      return part;
    }
    const fileId = parseUserFileId(getChatAttachmentUrl(part));
    const placeholder = fileId ? placeholderById.get(fileId) : undefined;
    return placeholder
      ? { ...part, metadata: { ...part.metadata, placeholder } }
      : part;
  });

// The cursor is the boundary message id alone. loadChatMessagePage resolves
// that row's exact (createdAt, id) in-DB, so the cursor never round-trips a
// timestamp through a millisecond-precision JS Date; messages sharing a
// millisecond (e.g. inserted in one transaction, which share now()) cannot be
// skipped. A malformed id is rejected here so it never reaches the uuid cast.
export const encodeMessagePageCursor = (id: SafeId<"chatMessage">): string =>
  encodePaginationCursor([id]);

export const decodeMessagePageCursor = (
  cursor: string,
): SafeId<"chatMessage"> | null => {
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 1) {
    return null;
  }

  const [rawId] = parts;
  if (!isUuidPaginationCursorPart(rawId)) {
    return null;
  }

  return brandPersistedChatMessageId(rawId);
};

type LoadChatMessagePageOnTxArgs = {
  tx: Transaction;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  /** Boundary message id; the page returns rows strictly older than it. */
  before?: SafeId<"chatMessage"> | undefined;
};

type LoadChatMessagePageArgs = SafeDbOrTx &
  Omit<LoadChatMessagePageOnTxArgs, "tx">;

export type ChatMessagePage = {
  messages: ClientMessage[];
  olderCursor: string | null;
  /** ISO timestamp of the newest message in this page (the last ascending
   *  row), or null when the page is empty. For the most-recent page this is
   *  the thread's last-activity timestamp. */
  lastActivityAt: string | null;
};

/**
 * Core query, callable directly against an already-open transaction so
 * callers sharing one scoped tx (e.g. get-messages.ts) can run it without
 * paying for a second `set_config`.
 */
const loadChatMessagePageOnTx = async ({
  tx,
  threadId,
  userId,
  before,
}: LoadChatMessagePageOnTxArgs): Promise<ChatMessagePage> => {
  const pageSize = LIMITS.chatMessagesPageSizeDefault;

  const rows = await tx
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, threadId),
        // Compare the full-precision (createdAt, id) tuple in-DB against
        // the boundary row (looked up by id), so the comparison stays at
        // the column's microsecond precision instead of the cursor's
        // millisecond JS Date.
        before
          ? sql`(${chatMessages.createdAt}, ${chatMessages.id}) < (select b.created_at, b.id from chat_messages b where b.id = ${before})`
          : undefined,
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(pageSize + 1);

  const hasOlder = rows.length > pageSize;
  const pageAscending = rows.slice(0, pageSize).toReversed();

  const oldest = pageAscending.at(0);
  const olderCursor =
    hasOlder && oldest ? encodeMessagePageCursor(oldest.id) : null;

  const placeholderById = await loadPlaceholdersOnTx({
    tx,
    userId,
    rows: pageAscending,
  });

  const lastActivityAt = pageAscending.at(-1)?.createdAt.toISOString() ?? null;

  return {
    messages: pageAscending.map((row) =>
      clientMessageFromPageRow(row, placeholderById),
    ),
    olderCursor,
    lastActivityAt,
  };
};

/**
 * Load one descending page of a thread's messages, returned ascending
 * (oldest-first), plus a cursor to fetch the page strictly older than the
 * oldest row. `before` walks backwards through history; omit it for the most
 * recent page.
 */
export const loadChatMessagePage = async ({
  threadId,
  userId,
  before,
  ...handle
}: LoadChatMessagePageArgs): Promise<Result<ChatMessagePage, SafeDbError>> =>
  await withScopedTx(
    handle,
    async (tx) =>
      await loadChatMessagePageOnTx({ tx, threadId, userId, before }),
  );

type ChatMessagePageRow = {
  content: PersistedChatMessageContent;
  id: SafeId<"chatMessage">;
  role: ChatMessageRole;
};

export const clientMessageFromPageRow = (
  row: ChatMessagePageRow,
  placeholderById: Map<string, string>,
): ClientMessage => {
  const message = chatMessageFromPersisted(row);
  return {
    id: message.id,
    ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
    role: message.role,
    parts: attachPlaceholders(message.parts, placeholderById),
  };
};

type LoadPlaceholdersOnTxArgs = {
  tx: Transaction;
  userId: SafeId<"user">;
  rows: { content: PersistedChatMessageContent }[];
};

const loadPlaceholdersOnTx = async ({
  tx,
  userId,
  rows,
}: LoadPlaceholdersOnTxArgs): Promise<Map<string, string>> => {
  const referencedFileIds = new Set<SafeId<"userFile">>();
  for (const row of rows) {
    for (const part of normalizePersistedChatMessageContent(row.content)
      .parts) {
      if (!isChatAttachmentPart(part)) {
        continue;
      }
      const fileId = parseUserFileId(getChatAttachmentUrl(part));
      if (fileId) {
        referencedFileIds.add(fileId);
      }
    }
  }

  const placeholderById = new Map<string, string>();
  if (referencedFileIds.size === 0) {
    return placeholderById;
  }

  const fileRows =
    // SAFETY: bounded by the `id IN (...)` set of file ids referenced by this page's messages (userFiles.id is the PK).
    // eslint-disable-next-line require-query-limit/require-query-limit
    await tx.query.userFiles.findMany({
      where: {
        id: { in: [...referencedFileIds] },
        userId: { eq: userId },
      },
      columns: { id: true, placeholder: true },
    });
  for (const fileRow of fileRows) {
    if (fileRow.placeholder !== null) {
      placeholderById.set(fileRow.id, fileRow.placeholder);
    }
  }

  return placeholderById;
};
