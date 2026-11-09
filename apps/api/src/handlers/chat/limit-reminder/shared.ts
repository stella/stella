import { Result } from "better-result";
import { and, desc, eq, isNull } from "drizzle-orm";
import * as v from "valibot";

import { CHAT_LIMIT_REMINDER_UNAVAILABLE } from "@stll/api-contract/chat-limit-reminder";

import type { Transaction } from "@/api/db/root";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import type { ChatScope } from "@/api/handlers/chat/chat-scope";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const limitReminderParams = v.object({
  threadId: resourceIdSchema("chatThread"),
});
export const limitReminderQuery = v.object({
  workspaceId: v.optional(resourceIdSchema("workspace")),
});

/** The member's own thread in this scope; undefined when it is not theirs. */
export const readOwnThread = async ({
  tx,
  threadId,
  organizationId,
  userId,
  scope,
}: {
  tx: Transaction;
  threadId: SafeId<"chatThread">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  scope: ChatScope;
}) => {
  const [thread] = await tx
    .select({ id: chatThreads.id, workspaceId: chatThreads.workspaceId })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, threadId),
        eq(chatThreads.organizationId, organizationId),
        eq(chatThreads.userId, userId),
        scope.scope === "workspace"
          ? eq(chatThreads.workspaceId, scope.workspaceId)
          : isNull(chatThreads.workspaceId),
      ),
    )
    .limit(1);
  return thread;
};

/** Only the reset time is read off the stored outcome. */
const limitOutcomeSchema = v.object({
  metadata: v.object({
    turnOutcome: v.object({
      type: v.literal("failed"),
      limitResetsAt: v.pipe(v.string(), v.isoTimestamp()),
    }),
  }),
});

/**
 * The thread's newest turn when it failed on the usage limit of the harness
 * on the member's computer and that limit resets in the future. Any other
 * newest turn (still running, continued, failed for another reason, or a
 * reset already past) leaves nothing to remind about.
 */
export const readLimitedLatestTurn = async ({
  tx,
  threadId,
  now,
}: {
  tx: Transaction;
  threadId: SafeId<"chatThread">;
  now: Date;
}): Promise<
  Result<{ turnId: SafeId<"chatTurn">; resetsAt: Date }, HandlerError>
> => {
  const [latest] = await tx
    .select({
      id: chatTurns.id,
      status: chatTurns.status,
      assistantMessageId: chatTurns.assistantMessageId,
    })
    .from(chatTurns)
    .where(eq(chatTurns.threadId, threadId))
    .orderBy(desc(chatTurns.createdAt), desc(chatTurns.id))
    .limit(1);
  const refused = Result.err(
    new HandlerError({
      status: 409,
      code: CHAT_LIMIT_REMINDER_UNAVAILABLE,
      message:
        "The chat's latest turn is not waiting for a usage limit to reset",
    }),
  );
  if (
    latest === undefined ||
    latest.status !== "failed" ||
    latest.assistantMessageId === null
  ) {
    return refused;
  }
  const [answer] = await tx
    .select({ content: chatMessages.content })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.id, latest.assistantMessageId),
        eq(chatMessages.threadId, threadId),
      ),
    )
    .limit(1);
  const parsed = v.safeParse(limitOutcomeSchema, answer?.content);
  if (!parsed.success) {
    return refused;
  }
  const resetsAt = new Date(parsed.output.metadata.turnOutcome.limitResetsAt);
  if (resetsAt.getTime() <= now.getTime()) {
    return refused;
  }
  return Result.ok({ turnId: latest.id, resetsAt });
};

export const chatThreadNotFound = () =>
  new HandlerError({
    status: 404,
    code: "not_found",
    message: "Chat thread not found",
  });

/** The reminder was cancelled while this request asked for it; ask again. */
export const limitReminderRaced = () =>
  new HandlerError({
    status: 409,
    code: CHAT_LIMIT_REMINDER_UNAVAILABLE,
    message: "The reminder changed while it was being set",
  });
