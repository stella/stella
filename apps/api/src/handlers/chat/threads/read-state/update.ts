import { panic, Result } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as v from "valibot";

import {
  CHAT_THREAD_NOT_FOUND_ERROR_CODE,
  chatThreadsChangedRealtimeEvent,
} from "@stll/api-contract";
import { CHAT_THREAD_READ_STATE } from "@stll/api-contract/chat";
import type { ChatThreadReadState } from "@stll/api-contract/chat";

import { defaultDatabaseRetry } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";
import { broadcastToUser } from "@/api/lib/sse";

const config = {
  contract: "patch",
  description:
    "Mark one of your own chat threads read or unread. read records that " +
    "you have seen its latest answer, so it reads unread again only once a " +
    "newer answer finishes; unread keeps it unread until it is marked read. " +
    "Idempotent. A thread that does not exist in the requested scope is a " +
    "404: this never creates one.",
  permissions: { chat: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "chat_thread_ui",
    consumesServices: false,
  },
  access: "write",
  realtime: noResourceSetUpdates(
    "Per-reader state: the reader's own devices learn of it from the chat-threads.changed user event this handler sends.",
  ),
  params: v.object({ threadId: resourceIdSchema("chatThread") }),
  query: v.object({ workspaceId: v.optional(resourceIdSchema("workspace")) }),
  body: v.object({
    readState: v.picklist(Object.values(CHAT_THREAD_READ_STATE)),
  }),
} satisfies HandlerConfig;

/**
 * The stored instant a read state leaves behind. Read takes the database
 * clock, the one turn settlement stamps `settled_at` with, so an answer that
 * settled before this write never reads unread. Unread clears it.
 */
const lastReadAtFor = (readState: ChatThreadReadState) => {
  switch (readState) {
    case CHAT_THREAD_READ_STATE.read:
      return sql<Date>`now()`;
    case CHAT_THREAD_READ_STATE.unread:
      return null;
    default:
      readState satisfies never;
      return panic(`Unhandled chat thread read state: ${String(readState)}`);
  }
};

const updateChatThreadReadState = createSafeRootHandler(
  config,
  async function* ({
    getWorkspaceAccess,
    body: { readState },
    query: { workspaceId },
    params,
    safeDb,
    session,
    user,
  }) {
    // Per-reader view state, not a matter write: an archived matter's chats
    // still open, so they can be marked too.
    const scope = yield* resolveChatScope({
      admitted: "active-or-archived",
      getWorkspaceAccess,
      workspaceId,
    });

    const updated = yield* Result.await(
      safeDb(
        async (tx) =>
          // audit: skip - per-reader read marker written on every open; no content, scope or access changes
          await tx
            .update(chatThreads)
            .set({
              lastReadAt: lastReadAtFor(readState),
              // Reading a chat does not make it recently active.
              updatedAt: sql`${chatThreads.updatedAt}`,
            })
            .where(
              and(
                eq(chatThreads.id, params.threadId),
                eq(chatThreads.organizationId, session.activeOrganizationId),
                eq(chatThreads.userId, user.id),
                scope.scope === "workspace"
                  ? eq(chatThreads.workspaceId, scope.workspaceId)
                  : isNull(chatThreads.workspaceId),
              ),
            )
            .returning({ id: chatThreads.id }),
        defaultDatabaseRetry,
      ),
    );

    if (updated.length === 0) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: CHAT_THREAD_NOT_FOUND_ERROR_CODE,
          message: "Chat thread not found",
          hint: "List your chats with chat.threads.list and pass a matter chat's matterId with it.",
        }),
      );
    }

    // After the commit, so the reader's other devices re-read the new state.
    broadcastToUser(
      user.id,
      session.activeOrganizationId,
      chatThreadsChangedRealtimeEvent(),
    );

    return Result.ok({ readState });
  },
);

declareAggregateMutation(updateChatThreadReadState, {
  type: "independent",
  reason:
    "Writes one column of one caller-owned chat thread in a single statement; no other row reads or depends on it.",
});

export default updateChatThreadReadState;
