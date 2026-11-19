import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { ChatLimitReminderResponse } from "@stll/api-contract/chat-limit-reminder";

import { chatLimitReminders } from "@/api/db/schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import {
  chatThreadNotFound,
  limitReminderParams,
  limitReminderQuery,
  readOwnThread,
} from "@/api/handlers/chat/limit-reminder/shared";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";

const config = {
  contract: "patch",
  permissions: { chat: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: limitReminderParams,
  query: limitReminderQuery,
} satisfies HandlerConfig;

/** Stop the reminder for this chat. Idempotent. */
const cancelChatLimitReminder = createSafeRootHandler(
  config,
  async function* ({
    getWorkspaceAccess,
    params: { threadId },
    query: { workspaceId },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const scope = yield* resolveChatScope({
      admitted: "active-or-archived",
      getWorkspaceAccess,
      workspaceId,
    });
    const found = yield* Result.await(
      safeDb(async (tx) => {
        const thread = await readOwnThread({
          tx,
          threadId,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          scope,
        });
        if (thread === undefined) {
          return false;
        }
        const [removed] = await tx
          .delete(chatLimitReminders)
          .where(
            and(
              eq(chatLimitReminders.threadId, threadId),
              eq(chatLimitReminders.userId, user.id),
            ),
          )
          .returning({ remindAt: chatLimitReminders.remindAt });
        if (removed !== undefined) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
            resourceId: threadId,
            workspaceId: thread.workspaceId,
            changes: {
              limitReminder: { old: removed.remindAt.toISOString(), new: null },
            },
          });
        }
        return true;
      }),
    );
    if (!found) {
      return Result.err(chatThreadNotFound());
    }
    return Result.ok({ remindAt: null } satisfies ChatLimitReminderResponse);
  },
);

declareAggregateMutation(cancelChatLimitReminder, {
  type: "independent",
  reason:
    "Deletes the member's one reminder row for the chat, keyed by the chat; no other row holds an invariant with it.",
});

export default cancelChatLimitReminder;
