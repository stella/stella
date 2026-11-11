import { panic, Result } from "better-result";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import * as v from "valibot";

import {
  CHAT_THREAD_NOT_FOUND_ERROR_CODE,
  chatThreadsChangedRealtimeEvent,
} from "@stll/api-contract";
import { CHAT_THREAD_PIN_STATE } from "@stll/api-contract/chat";
import type { ChatThreadPinState } from "@stll/api-contract/chat";

import { defaultDatabaseRetry } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";
import { broadcastToUser } from "@/api/lib/sse";

const config = {
  contract: "patch",
  description:
    "Pin one of your own chat threads to the top of your chat list, or " +
    "unpin it. Idempotent: pinning a pinned thread changes nothing. A thread that does not exist in the requested scope is a 404: " +
    "this never creates one.",
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
    pinState: v.picklist(Object.values(CHAT_THREAD_PIN_STATE)),
  }),
} satisfies HandlerConfig;

/**
 * The write a pin state makes, and the state it replaces. The transition is
 * conditional on the replaced state, so a write that changes nothing
 * matches no row and records nothing.
 */
const pinTransitionTo = (pinState: ChatThreadPinState) => {
  switch (pinState) {
    case CHAT_THREAD_PIN_STATE.pinned:
      return {
        pinnedAt: sql<Date>`now()`,
        previous: CHAT_THREAD_PIN_STATE.unpinned,
        replaces: isNull(chatThreads.pinnedAt),
      };
    case CHAT_THREAD_PIN_STATE.unpinned:
      return {
        pinnedAt: null,
        previous: CHAT_THREAD_PIN_STATE.pinned,
        replaces: isNotNull(chatThreads.pinnedAt),
      };
    default:
      pinState satisfies never;
      return panic(`Unhandled chat thread pin state: ${String(pinState)}`);
  }
};

const updateChatThreadPinState = createSafeRootHandler(
  config,
  async function* ({
    getWorkspaceAccess,
    body: { pinState },
    query: { workspaceId },
    params,
    safeDb,
    session,
    user,
    recordAuditEvent,
  }) {
    // Per-reader list state, not a matter write: an archived matter's chats
    // still list, so they can be pinned too.
    const scope = yield* resolveChatScope({
      admitted: "active-or-archived",
      getWorkspaceAccess,
      workspaceId,
    });
    const scopedWorkspaceId =
      scope.scope === "workspace" ? scope.workspaceId : null;

    const updated = yield* Result.await(
      safeDb(async (tx) => {
        const threadPredicate = and(
          eq(chatThreads.id, params.threadId),
          eq(chatThreads.organizationId, session.activeOrganizationId),
          eq(chatThreads.userId, user.id),
          scopedWorkspaceId === null
            ? isNull(chatThreads.workspaceId)
            : eq(chatThreads.workspaceId, scopedWorkspaceId),
        );
        const transition = pinTransitionTo(pinState);
        const changed = await tx
          .update(chatThreads)
          .set({
            pinnedAt: transition.pinnedAt,
            // Pinning a chat does not make it recently active.
            updatedAt: sql`${chatThreads.updatedAt}`,
          })
          .where(and(threadPredicate, transition.replaces))
          .returning({ id: chatThreads.id });
        if (changed.length === 0) {
          const [existing] = await tx
            .select({ id: chatThreads.id })
            .from(chatThreads)
            .where(threadPredicate)
            .limit(1);
          return existing === undefined ? null : "unchanged";
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
          resourceId: params.threadId,
          workspaceId: scopedWorkspaceId,
          changes: { pinState: { old: transition.previous, new: pinState } },
        });
        return "changed";
      }, defaultDatabaseRetry),
    );

    if (updated === null) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: CHAT_THREAD_NOT_FOUND_ERROR_CODE,
          message: "Chat thread not found",
          hint: "List your chats with chat.threads.list and pass a matter chat's matterId with it.",
        }),
      );
    }

    if (updated === "changed") {
      // After the commit, so the reader's other devices re-read the new state.
      broadcastToUser(
        user.id,
        session.activeOrganizationId,
        chatThreadsChangedRealtimeEvent(),
      );
    }

    return Result.ok({ pinState });
  },
);

declareAggregateMutation(updateChatThreadPinState, {
  type: "independent",
  reason:
    "Transitions one caller-owned chat thread conditionally on its pin state and records its audit row; no other row reads or depends on it.",
});

export default updateChatThreadPinState;
