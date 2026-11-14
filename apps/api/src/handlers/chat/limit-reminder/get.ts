import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";

import type { ChatLimitReminderResponse } from "@stll/api-contract/chat-limit-reminder";

import { chatLimitReminders, chatTurns } from "@/api/db/schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import {
  chatThreadNotFound,
  limitReminderParams,
  limitReminderQuery,
  readOwnThread,
} from "@/api/handlers/chat/limit-reminder/shared";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AssertNoExtraFields } from "@/api/lib/projection-totality";

const config = {
  contract: "patch",
  // `chat` has no read verb; sibling chat reads gate on `create`.
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: limitReminderParams,
  query: limitReminderQuery,
} satisfies HandlerConfig;

/** When the member will hear that their chat's usage limit reset, if they asked. */
const getChatLimitReminder = createSafeRootHandler(
  config,
  async function* ({
    getWorkspaceAccess,
    params: { threadId },
    query: { workspaceId },
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
          return null;
        }
        const [reminder] = await tx
          .select({
            remindAt: chatLimitReminders.remindAt,
            turnId: chatLimitReminders.turnId,
          })
          .from(chatLimitReminders)
          .where(
            and(
              eq(chatLimitReminders.threadId, threadId),
              eq(chatLimitReminders.userId, user.id),
            ),
          )
          .limit(1);
        if (reminder === undefined) {
          return { reminder };
        }
        // A reminder kept for an earlier turn sends nothing once a newer turn
        // exists (the sweep skips it), so it is not shown: the member can ask
        // again for the newest turn, which replaces it.
        const [latest] = await tx
          .select({ id: chatTurns.id })
          .from(chatTurns)
          .where(eq(chatTurns.threadId, threadId))
          .orderBy(desc(chatTurns.createdAt), desc(chatTurns.id))
          .limit(1);
        return {
          reminder: latest?.id === reminder.turnId ? reminder : undefined,
        };
      }),
    );
    if (found === null) {
      return Result.err(chatThreadNotFound());
    }
    const response = {
      remindAt: found.reminder?.remindAt.toISOString() ?? null,
    };
    return Result.ok(
      response satisfies AssertNoExtraFields<
        typeof response,
        ChatLimitReminderResponse
      >,
    );
  },
);

export default getChatLimitReminder;
