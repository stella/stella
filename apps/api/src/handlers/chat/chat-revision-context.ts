import { panic, Result } from "better-result";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { SafeDbError, SafeDbOrTx } from "@/api/db/safe-db";
import { withScopedTx } from "@/api/db/safe-db";
import { chatMessageRevisions, chatMessages } from "@/api/db/schema";
import { normalizePersistedChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import type {
  ChatMessage,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import { encodePaginationCursor } from "@/api/lib/pagination";
import { brandPersistedChatMessageId } from "@/api/lib/safe-id-boundaries";

export const CHAT_REVISION_CONTEXT_MAX_EDITS = 32;

export type ChatRevisionContextChange = {
  messageId: SafeId<"chatMessage">;
  revision: number;
  before: string;
  after: string;
};

const nextRevision = alias(chatMessageRevisions, "next_chat_message_revision");

export const revisionText = (content: PersistedChatMessageContent): string =>
  normalizePersistedChatMessageContent(content)
    .parts.filter((part) => part.type === "text")
    .map((part) => part.content)
    .join("");

type ReadChatRevisionContextChangesOptions = SafeDbOrTx & {
  messages: readonly Pick<ChatMessage, "id" | "role">[];
  threadId: SafeId<"chatThread">;
};

/** A bounded batch of accepted edits belonging to the provider-visible history. */
export const readChatRevisionContextChanges = async ({
  messages,
  threadId,
  ...handle
}: ReadChatRevisionContextChangesOptions): Promise<
  Result<ChatRevisionContextChange[], SafeDbError>
> => {
  const messageIds = messages
    .filter((message) => message.role === "assistant")
    .map((message) => brandPersistedChatMessageId(message.id));
  if (messageIds.length === 0) {
    return Result.ok([]);
  }

  return await withScopedTx(handle, async (tx) => {
    const page = await readCursorPage(
      tx
        .select({
          messageId: chatMessageRevisions.messageId,
          revision: chatMessageRevisions.revision,
          content: chatMessageRevisions.content,
          nextContent: nextRevision.content,
          currentContent: chatMessages.content,
          currentRevision: chatMessages.revision,
        })
        .from(chatMessageRevisions)
        .innerJoin(
          chatMessages,
          and(
            eq(chatMessages.id, chatMessageRevisions.messageId),
            eq(chatMessages.threadId, threadId),
            eq(chatMessages.role, "assistant"),
          ),
        )
        .leftJoin(
          nextRevision,
          and(
            eq(nextRevision.messageId, chatMessageRevisions.messageId),
            eq(nextRevision.threadId, threadId),
            eq(
              nextRevision.revision,
              sql`${chatMessageRevisions.revision} + 1`,
            ),
          ),
        )
        .where(
          and(
            eq(chatMessageRevisions.threadId, threadId),
            inArray(chatMessageRevisions.messageId, messageIds),
            lt(chatMessageRevisions.revision, chatMessages.revision),
          ),
        )
        .orderBy(
          desc(chatMessageRevisions.createdAt),
          desc(chatMessageRevisions.revision),
          desc(chatMessageRevisions.id),
        ),
      {
        limit: CHAT_REVISION_CONTEXT_MAX_EDITS,
        cursorForItem: (row) =>
          encodePaginationCursor([row.messageId, row.revision]),
      },
    );

    // Prompt context uses only the newest page; earlier edits stay in history.
    return page.items.map((row) => {
      if (
        row.nextContent === null &&
        row.revision + 1 !== row.currentRevision
      ) {
        return panic(
          "Accepted chat revision is missing its successor snapshot",
        );
      }
      return {
        messageId: row.messageId,
        revision: row.revision + 1,
        before: revisionText(row.content),
        after: revisionText(row.nextContent ?? row.currentContent),
      };
    });
  });
};
