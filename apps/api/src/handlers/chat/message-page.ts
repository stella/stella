import type { Result } from "better-result";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDbError, SafeDbOrTx } from "@/api/db/safe-db";
import { withScopedTx } from "@/api/db/safe-db";
import { chatMessages, chatTurns } from "@/api/db/schema";
import {
  chatMessageFromPersisted,
  getChatAttachmentUrl,
  isChatAttachmentPart,
  normalizePersistedChatMessageContent,
} from "@/api/handlers/chat/chat-message-parts";
import { ACTIVE_CHAT_TURN_STATUSES } from "@/api/handlers/chat/chat-turn-state";
import type {
  ChatMessageMetadata,
  ChatMessageRole,
  ChatPart,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedChatMessageId } from "@/api/lib/safe-id-boundaries";
import { parseUserFileId } from "@/api/lib/user-files/types";

export type ClientMessage = {
  createdAt: string;
  id: SafeId<"chatMessage">;
  metadata?: ChatMessageMetadata;
  role: ChatMessageRole;
  parts: ChatPart[];
};

/**
 * Attach the stored blur placeholder to image file parts so the client can
 * render a blur-up while the thumbnail loads. The thumbnail URL itself is
 * derived client-side from the user-file id, so only the DB-sourced
 * placeholder needs to travel with the message.
 */
const attachPlaceholders = (
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
  /** The thread's turn not yet settled (accepted, running, or awaiting the
   *  user), which the page stops; null when every turn has settled. */
  activeTurnId: SafeId<"chatTurn"> | null;
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

  const lastActivityAt = pageAscending.at(-1)?.createdAt.toISOString() ?? null;

  const activeTurn = (
    await tx
      .select({ id: chatTurns.id })
      .from(chatTurns)
      .where(
        and(
          eq(chatTurns.threadId, threadId),
          inArray(chatTurns.status, [...ACTIVE_CHAT_TURN_STATUSES]),
        ),
      )
      .limit(1)
  ).at(0);

  return {
    activeTurnId: activeTurn?.id ?? null,
    messages: await projectPageRowsOnTx({ rows: pageAscending, tx, userId }),
    olderCursor,
    lastActivityAt,
  };
};

/**
 * Rows as the thread's page serves them: each message with its stored
 * timestamp, its attachments carrying the placeholders of the files they
 * reference.
 */
const projectPageRowsOnTx = async ({
  rows,
  tx,
  userId,
}: {
  rows: readonly ChatMessagePageRow[];
  tx: Transaction;
  userId: SafeId<"user">;
}): Promise<ClientMessage[]> => {
  const placeholderById = await loadPlaceholdersOnTx({ rows, tx, userId });
  return rows.map((row) => clientMessageFromPageRow(row, placeholderById));
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

/**
 * The thread's messages `messageIds` names, as its page serves them, in
 * thread order.
 */
export const loadClientMessages = async ({
  messageIds,
  threadId,
  userId,
  ...handle
}: SafeDbOrTx & {
  messageIds: readonly SafeId<"chatMessage">[];
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
}): Promise<Result<ClientMessage[], SafeDbError>> =>
  await withScopedTx(handle, async (tx) => {
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
          inArray(chatMessages.id, [...messageIds]),
        ),
      )
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
      .limit(messageIds.length);
    return await projectPageRowsOnTx({ rows, tx, userId });
  });

type ChatMessagePageRow = {
  content: PersistedChatMessageContent;
  createdAt: Date;
  id: SafeId<"chatMessage">;
  role: ChatMessageRole;
};

export const clientMessageFromPageRow = (
  row: ChatMessagePageRow,
  placeholderById: Map<string, string>,
): ClientMessage => {
  const message = chatMessageFromPersisted(row);
  return {
    createdAt: row.createdAt.toISOString(),
    id: message.id,
    ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
    role: message.role,
    parts: attachPlaceholders(message.parts, placeholderById),
  };
};

type LoadPlaceholdersOnTxArgs = {
  tx: Transaction;
  userId: SafeId<"user">;
  rows: readonly { content: PersistedChatMessageContent }[];
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

  const fileRows = await tx.query.userFiles.findMany({
    where: {
      id: { in: [...referencedFileIds] },
      userId: { eq: userId },
    },
    columns: { id: true, placeholder: true },
    limit: referencedFileIds.size,
  });
  for (const fileRow of fileRows) {
    if (fileRow.placeholder !== null) {
      placeholderById.set(fileRow.id, fileRow.placeholder);
    }
  }

  return placeholderById;
};
