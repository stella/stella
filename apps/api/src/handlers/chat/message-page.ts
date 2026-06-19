import { Result } from "better-result";

import type { SafeDb, SafeDbError } from "@/api/db";
import { normalizeLegacyToolInputs } from "@/api/handlers/chat/legacy-tool-compat";
import type {
  ChatMessageRole,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import { parseUserFileId } from "@/api/handlers/user-files/types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import { brandPersistedChatMessageId } from "@/api/lib/safe-id-boundaries";

type ChatPart = ReturnType<typeof normalizeLegacyToolInputs>[number];

export type ClientMessage = {
  id: SafeId<"chatMessage">;
  role: ChatMessageRole;
  parts: ChatPart[];
};

type MessagePageCursor = {
  createdAt: Date;
  id: SafeId<"chatMessage">;
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
    if (part.type !== "file") {
      return part;
    }
    const fileId = parseUserFileId(part.url);
    const placeholder = fileId ? placeholderById.get(fileId) : undefined;
    return placeholder ? { ...part, placeholder } : part;
  });

export const encodeMessagePageCursor = ({
  createdAt,
  id,
}: MessagePageCursor): string =>
  encodePaginationCursor([createdAt.toISOString(), id]);

export const decodeMessagePageCursor = (
  cursor: string,
): MessagePageCursor | null => {
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 2) {
    return null;
  }

  const [rawCreatedAt, rawId] = parts;
  if (typeof rawCreatedAt !== "string" || typeof rawId !== "string") {
    return null;
  }

  const createdAt = new Date(rawCreatedAt);
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }

  return { createdAt, id: brandPersistedChatMessageId(rawId) };
};

type LoadChatMessagePageArgs = {
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  before?: MessagePageCursor | undefined;
};

export type ChatMessagePage = {
  messages: ClientMessage[];
  olderCursor: string | null;
  /** ISO timestamp of the newest message in this page (the last ascending
   *  row), or null when the page is empty. For the most-recent page this is
   *  the thread's last-activity timestamp. */
  lastActivityAt: string | null;
};

/**
 * Load one descending page of a thread's messages, returned ascending
 * (oldest-first), plus a cursor to fetch the page strictly older than the
 * oldest row. `before` walks backwards through history; omit it for the most
 * recent page.
 */
export const loadChatMessagePage = async ({
  safeDb,
  threadId,
  userId,
  before,
}: LoadChatMessagePageArgs): Promise<Result<ChatMessagePage, SafeDbError>> =>
  await Result.gen(async function* () {
    const pageSize = LIMITS.chatMessagesPageSizeDefault;

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx.query.chatMessages.findMany({
          where: {
            threadId: { eq: threadId },
            ...(before
              ? {
                  OR: [
                    { createdAt: { lt: before.createdAt } },
                    {
                      createdAt: { eq: before.createdAt },
                      id: { lt: before.id },
                    },
                  ],
                }
              : {}),
          },
          columns: {
            id: true,
            role: true,
            content: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc", id: "desc" },
          limit: pageSize + 1,
        }),
      ),
    );

    const hasOlder = rows.length > pageSize;
    const pageAscending = rows.slice(0, pageSize).toReversed();

    const oldest = pageAscending.at(0);
    const olderCursor =
      hasOlder && oldest
        ? encodeMessagePageCursor({
            createdAt: oldest.createdAt,
            id: oldest.id,
          })
        : null;

    const placeholderById = yield* Result.await(
      loadPlaceholders({ safeDb, userId, rows: pageAscending }),
    );

    const lastActivityAt =
      pageAscending.at(-1)?.createdAt.toISOString() ?? null;

    return Result.ok({
      messages: pageAscending.map((row) => ({
        id: row.id,
        role: row.role,
        parts: attachPlaceholders(
          normalizeLegacyToolInputs(row.content.data),
          placeholderById,
        ),
      })),
      olderCursor,
      lastActivityAt,
    });
  });

type LoadPlaceholdersArgs = {
  safeDb: SafeDb;
  userId: SafeId<"user">;
  rows: { content: PersistedChatMessageContent }[];
};

const loadPlaceholders = async ({
  safeDb,
  userId,
  rows,
}: LoadPlaceholdersArgs): Promise<Result<Map<string, string>, SafeDbError>> =>
  await Result.gen(async function* () {
    const referencedFileIds = new Set<SafeId<"userFile">>();
    for (const row of rows) {
      for (const part of row.content.data) {
        if (part.type !== "file") {
          continue;
        }
        const fileId = parseUserFileId(part.url);
        if (fileId) {
          referencedFileIds.add(fileId);
        }
      }
    }

    const placeholderById = new Map<string, string>();
    if (referencedFileIds.size === 0) {
      return Result.ok(placeholderById);
    }

    const fileRows = yield* Result.await(
      safeDb((tx) =>
        // SAFETY: bounded by the `id IN (...)` set of file ids referenced by this page's messages (userFiles.id is the PK).
        // eslint-disable-next-line require-query-limit/require-query-limit
        tx.query.userFiles.findMany({
          where: {
            id: { in: [...referencedFileIds] },
            userId: { eq: userId },
          },
          columns: { id: true, placeholder: true },
        }),
      ),
    );
    for (const fileRow of fileRows) {
      if (fileRow.placeholder !== null) {
        placeholderById.set(fileRow.id, fileRow.placeholder);
      }
    }

    return Result.ok(placeholderById);
  });
