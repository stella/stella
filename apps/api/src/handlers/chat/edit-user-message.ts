import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { CHAT_MESSAGE_EDIT_ERROR_CODE } from "@stll/api-contract";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import { resolveEditedUserMessageId } from "@/api/handlers/chat/chat-schema";
import type { ChatSendRequest } from "@/api/handlers/chat/chat-schema";
import { canAcceptChatTurnOnTx } from "@/api/handlers/chat/chat-turn-persistence";
import type { ChatTurnRefusal } from "@/api/handlers/chat/chat-turn-persistence";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type AuthorizeChatUserMessageEditArgs = {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  targetMessageId: SafeId<"chatMessage">;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
};

type EditStanding = "editable" | "missing" | "not-user-message" | "running";

export type ChatUserMessageEditRefusal = HandlerError<404 | 409>;

const missingRefusal = () =>
  new HandlerError({
    code: CHAT_MESSAGE_EDIT_ERROR_CODE.targetMissing,
    message: "The message to edit is not in this chat",
    status: 404,
  });

const REFUSALS = {
  missing: missingRefusal,
  "not-user-message": () =>
    new HandlerError({
      code: CHAT_MESSAGE_EDIT_ERROR_CODE.targetNotUserMessage,
      message: "Only a user message can be edited",
      status: 409,
    }),
  running: () =>
    new HandlerError({
      code: CHAT_MESSAGE_EDIT_ERROR_CODE.turnRunning,
      message: "A chat turn is still running; stop it before editing",
      status: 409,
    }),
} as const satisfies Record<
  Exclude<EditStanding, "editable">,
  () => ChatUserMessageEditRefusal
>;

/** An edit whose target left the thread after it was authorized. */
export const refuseChatUserMessageEditTarget = missingRefusal;

/**
 * Why saving an edit failed under the thread lock, typed like every other
 * edit refusal: a turn that started after the authorization, or a thread
 * another turn changed in between.
 */
export const refuseChatUserMessageEditTurn = (
  refusal: ChatTurnRefusal,
): HandlerError<409> => {
  switch (refusal) {
    case "turn-running":
      return new HandlerError({
        code: CHAT_MESSAGE_EDIT_ERROR_CODE.turnRunning,
        message: "A chat turn started before the edit was saved",
        status: 409,
      });
    case "history-changed":
      return new HandlerError({
        code: CHAT_MESSAGE_EDIT_ERROR_CODE.historyChanged,
        message: "The chat changed while the edit was being saved",
        status: 409,
      });
    default:
      refusal satisfies never;
      return panic("Unhandled chat turn refusal");
  }
};

/**
 * Whether the requester may replace `targetMessageId` and drop every turn
 * after it. The message must be a user message of this thread, the thread
 * must belong to the requester in the active organization, and no turn of the
 * thread may still run. Ownership is part of the query itself,
 * not only of row security, so the check holds on any connection.
 *
 * This is the typed gate in front of the edit. Persisting the edit takes the
 * thread lock and refuses a turn that started, or a history that moved, since
 * this read (`persistAcceptedMessageWithClaim`).
 */
export const authorizeChatUserMessageEdit = async ({
  organizationId,
  safeDb,
  targetMessageId,
  threadId,
  userId,
}: AuthorizeChatUserMessageEditArgs): Promise<
  Result<void, ChatUserMessageEditRefusal | SafeDbError>
> => {
  const standing = await safeDb(async (tx): Promise<EditStanding> => {
    const target = await tx
      .select({ role: chatMessages.role })
      .from(chatMessages)
      .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
      .where(
        and(
          eq(chatMessages.id, targetMessageId),
          eq(chatMessages.threadId, threadId),
          eq(chatThreads.id, threadId),
          eq(chatThreads.organizationId, organizationId),
          eq(chatThreads.userId, userId),
        ),
      )
      .limit(1);
    const role = target.at(0)?.role;
    if (role === undefined) {
      return "missing";
    }
    if (role !== "user") {
      return "not-user-message";
    }
    // The same check a new message passes under the thread lock: a running
    // turn whose owner is gone ends here, a live one refuses the edit.
    return (await canAcceptChatTurnOnTx({ threadId, tx }))
      ? "editable"
      : "running";
  });
  if (Result.isError(standing)) {
    return Result.err(standing.error);
  }
  if (standing.value === "editable") {
    return Result.ok(undefined);
  }
  return Result.err(REFUSALS[standing.value]());
};

/**
 * The send handler's gate: a request that edits a stored user message
 * passes `authorizeChatUserMessageEdit` before anything reads or writes the
 * thread; any other request passes through.
 */
export const authorizeRequestedUserMessageEdit = async ({
  body,
  organizationId,
  safeDb,
  userId,
}: {
  body: Pick<
    ChatSendRequest,
    "message" | "threadId" | "truncateAfterMessageId" | "turnIntent"
  >;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<
  Result<void, ChatUserMessageEditRefusal | HandlerError<400> | SafeDbError>
> => {
  const edited = resolveEditedUserMessageId(body);
  if (Result.isError(edited)) {
    return Result.err(edited.error);
  }
  if (edited.value === null) {
    return Result.ok(undefined);
  }
  return await authorizeChatUserMessageEdit({
    organizationId,
    safeDb,
    targetMessageId: edited.value,
    threadId: body.threadId,
    userId,
  });
};
