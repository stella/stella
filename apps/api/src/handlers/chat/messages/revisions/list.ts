import { Result } from "better-result";
import { and, desc, eq, lt } from "drizzle-orm";
import { t } from "elysia";

import type { Transaction } from "@/api/db/root";
import {
  chatMessages,
  chatMessageRevisions,
  chatThreads,
} from "@/api/db/schema";
import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import { revisionParams } from "@/api/handlers/chat/messages/revisions/accept";
import type { PersistedChatMessageContent } from "@/api/handlers/chat/types";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

const MAX_REVISION_PAGE_SIZE = 50;
const DEFAULT_REVISION_PAGE_SIZE = 20;

type RevisionSnapshot = {
  version: PersistedChatMessageContent["version"];
  data: unknown[];
  metadata?: unknown;
};

// Persistence proofs belong to the server; snapshots expose only stored JSON.
const serializeRevisionSnapshot = (
  content: PersistedChatMessageContent,
): RevisionSnapshot => ({
  version: content.version,
  data: content.data,
  ...(content.version === 1 || content.metadata === undefined
    ? {}
    : { metadata: content.metadata }),
});

const config = {
  contentDelivery: {
    type: "none",
    reason: "Returns answer snapshots rather than stored-file grants.",
  },
  description:
    "Read retained versions of an assistant answer in your chat thread, newest first. Each item contains the replaced content and the accepted edit. The current answer is returned by chat.messages.list. Use nextCursor to read earlier versions.",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "assistant_chat",
    consumesServices: false,
  },
  params: revisionParams,
  query: t.Object({
    cursor: t.Optional(tPaginationCursor()),
    limit: t.Optional(tPaginationLimit(MAX_REVISION_PAGE_SIZE)),
  }),
} satisfies HandlerConfig;

type ReadChatMessageRevisionsOptions = {
  tx: Transaction;
  threadId: SafeId<"chatThread">;
  messageId: SafeId<"chatMessage">;
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  before?: number;
  limit: number;
};

export const readChatMessageRevisionsOnTx = async ({
  tx,
  threadId,
  messageId,
  userId,
  organizationId,
  before,
  limit,
}: ReadChatMessageRevisionsOptions) => {
  const message = (
    await tx
      .select({ role: chatMessages.role })
      .from(chatMessages)
      .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatThreads.id, threadId),
          eq(chatThreads.userId, userId),
          eq(chatThreads.organizationId, organizationId),
        ),
      )
      .limit(1)
  ).at(0);
  if (!message) {
    return null;
  }
  const rows = await tx
    .select()
    .from(chatMessageRevisions)
    .where(
      and(
        eq(chatMessageRevisions.messageId, messageId),
        eq(chatMessageRevisions.threadId, threadId),
        before === undefined
          ? undefined
          : lt(chatMessageRevisions.revision, before),
      ),
    )
    .orderBy(desc(chatMessageRevisions.revision))
    .limit(limit + 1);
  return createCursorPage({
    rows: rows.map(({ content, ...revision }) => ({
      ...revision,
      content: serializeRevisionSnapshot(content),
    })),
    limit,
    cursorForItem: (item) => encodePaginationCursor([item.revision]),
  });
};

type RevisionRow = typeof chatMessageRevisions.$inferSelect;
type RevisionListItem = NonNullable<
  Awaited<ReturnType<typeof readChatMessageRevisionsOnTx>>
>["items"][number];

true satisfies UnprojectedColumns<RevisionRow, RevisionListItem> extends never
  ? true
  : never;
true satisfies UnbackedProjectionKeys<
  RevisionRow,
  RevisionListItem
> extends never
  ? true
  : never;

export default createSafeRootHandler(
  config,
  async function* ({
    params: { threadId, messageId },
    query: { cursor, limit = DEFAULT_REVISION_PAGE_SIZE },
    safeDb,
    user,
    session,
  }) {
    const decoded =
      cursor === undefined ? undefined : decodePaginationCursor(cursor);
    const before = decoded?.at(0);
    if (
      cursor !== undefined &&
      (decoded?.length !== 1 ||
        typeof before !== "number" ||
        !Number.isInteger(before) ||
        before < 0)
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "Invalid revision cursor; use nextCursor from the previous page",
        }),
      );
    }
    const page = yield* Result.await(
      safeDb(
        async (tx) =>
          await readChatMessageRevisionsOnTx({
            tx,
            threadId,
            messageId,
            userId: user.id,
            organizationId: session.activeOrganizationId,
            ...(typeof before === "number" ? { before } : {}),
            limit,
          }),
      ),
    );
    if (page === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Chat message not found" }),
      );
    }
    return Result.ok(page);
  },
);
