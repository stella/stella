import { Result } from "better-result";
import { and, eq, ne, or } from "drizzle-orm";
import * as v from "valibot";

import {
  CHAT_LIMIT_RESET_ACTIONS,
  type ChatLimitReminderResponse,
} from "@stll/api-contract/chat-limit-reminder";

import { chatLimitReminders } from "@/api/db/schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import {
  chatThreadNotFound,
  limitReminderParams,
  limitReminderQuery,
  limitReminderRaced,
  readLimitedLatestTurn,
  readOwnThread,
} from "@/api/handlers/chat/limit-reminder/shared";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";

const config = {
  contract: "patch",
  permissions: { chat: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: limitReminderParams,
  query: limitReminderQuery,
  body: v.strictObject({ onReset: v.picklist(CHAT_LIMIT_RESET_ACTIONS) }),
  aggregateMutation: {
    type: "independent",
    reason:
      "Writes the member's one reminder row for the chat, keyed by the chat; a concurrent set meets the key and settles as a race, so no other row holds an invariant with it.",
  },
} satisfies HandlerConfig;

/**
 * Ask what happens when the usage limit that stopped the chat's latest turn
 * on the member's computer resets: hear about it, or have the chat continue.
 * The time is the one the harness reported for that turn, read here, never
 * taken from the request. Asking again for the same thing is a no-op; asking
 * for the other replaces it.
 */
const setChatLimitReminder = createSafeRootHandler(
  config,
  async function* ({
    body: { onReset },
    getWorkspaceAccess,
    params: { threadId },
    query: { workspaceId },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const scope = yield* resolveChatScope({
      admitted: "active",
      getWorkspaceAccess,
      workspaceId,
    });
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const thread = await readOwnThread({
          tx,
          threadId,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          scope,
        });
        if (thread === undefined) {
          return Result.err(chatThreadNotFound());
        }
        const limited = await readLimitedLatestTurn({
          tx,
          threadId,
          now: new Date(),
        });
        if (limited.isErr()) {
          return Result.err(limited.error);
        }
        const { resetsAt, turnId } = limited.value;
        // A reminder left from an earlier stopped turn is replaced, never
        // kept: the sweep would see this newer turn and send nothing. One
        // asking for the other action is replaced too (rows never update).
        const [replaced] = await tx
          .delete(chatLimitReminders)
          .where(
            and(
              eq(chatLimitReminders.threadId, threadId),
              eq(chatLimitReminders.userId, user.id),
              or(
                ne(chatLimitReminders.turnId, turnId),
                ne(chatLimitReminders.onReset, onReset),
              ),
            ),
          )
          .returning({
            remindAt: chatLimitReminders.remindAt,
            onReset: chatLimitReminders.onReset,
          });
        const [inserted] = await tx
          .insert(chatLimitReminders)
          .values({
            threadId,
            turnId,
            organizationId: session.activeOrganizationId,
            userId: user.id,
            remindAt: resetsAt,
            onReset,
          })
          .onConflictDoNothing()
          .returning({
            remindAt: chatLimitReminders.remindAt,
            onReset: chatLimitReminders.onReset,
          });
        if (inserted === undefined) {
          // Asked again for the same turn: the stored reminder stands.
          const [existing] = await tx
            .select({
              remindAt: chatLimitReminders.remindAt,
              onReset: chatLimitReminders.onReset,
            })
            .from(chatLimitReminders)
            .where(
              and(
                eq(chatLimitReminders.threadId, threadId),
                eq(chatLimitReminders.userId, user.id),
              ),
            )
            .limit(1);
          return existing === undefined
            ? Result.err(limitReminderRaced())
            : Result.ok(existing);
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
          resourceId: threadId,
          workspaceId: thread.workspaceId,
          changes: {
            limitReminder: {
              old: replaced?.remindAt.toISOString() ?? null,
              new: inserted.remindAt.toISOString(),
            },
            limitReminderOnReset: {
              old: replaced?.onReset ?? null,
              new: onReset,
            },
          },
        });
        return Result.ok(inserted);
      }),
    );
    const stored = yield* outcome;
    return Result.ok({
      remindAt: stored.remindAt.toISOString(),
      onReset: stored.onReset,
    } satisfies ChatLimitReminderResponse);
  },
);

export default setChatLimitReminder;
