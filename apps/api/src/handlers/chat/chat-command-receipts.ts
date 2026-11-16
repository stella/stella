import { Result, TaggedError } from "better-result";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import { CHAT_TURN_ID_HEADER } from "@stll/api-contract";
import {
  CHAT_COMMAND_ERROR_CODE,
  CHAT_COMMAND_ID_HEADER,
  type ChatCommandType,
} from "@stll/api-contract/chat-command";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { chatCommandReceipts } from "@/api/db/schema";
import type { ResponseHeaders } from "@/api/http/context";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/**
 * A member's command (a send, an answer) under the id their client chose
 * (`@stll/api-contract/chat-command`).
 */
export type ChatCommand = {
  commandId: string;
  type: ChatCommandType;
};

/**
 * The command a request carries: its id from `CHAT_COMMAND_ID_HEADER`, typed
 * by what the request does. A request without one carries none; a malformed
 * id is refused, since a retry could not be matched to it.
 */
export const chatCommandOf = (
  headers: Readonly<Record<string, string>>,
  type: ChatCommandType,
): Result<ChatCommand | undefined, HandlerError<400>> => {
  const header = headers[CHAT_COMMAND_ID_HEADER];
  if (header === undefined) {
    return Result.ok(undefined);
  }
  return v.is(v.pipe(v.string(), v.uuid()), header)
    ? Result.ok({ commandId: header.toLowerCase(), type })
    : Result.err(
        new HandlerError({
          status: 400,
          code: CHAT_COMMAND_ERROR_CODE.invalidId,
          message: `${CHAT_COMMAND_ID_HEADER} must be a UUID`,
        }),
      );
};

/** The command was accepted earlier: the request is not run again. */
export class ChatCommandReplayedError extends TaggedError(
  "ChatCommandReplayedError",
)<{
  message: string;
  /** The turn the first attempt started or continued. */
  turnId: SafeId<"chatTurn">;
}> {}

const commandConflict = () =>
  new HandlerError({
    status: 409,
    code: CHAT_COMMAND_ERROR_CODE.conflict,
    message:
      "The command id was already used for another chat thread or command",
  });

type ChatCommandScope = {
  command: ChatCommand;
  threadId: SafeId<"chatThread">;
};

/**
 * What a stored receipt of the command says about this request: replay the
 * accepted outcome, refuse an id used elsewhere, or nothing when the command
 * has no receipt. Row-level security shows only the member's own receipts.
 */
export const chatCommandReceiptOutcomeOnTx = async ({
  command,
  threadId,
  tx,
}: ChatCommandScope & { tx: Transaction }): Promise<
  ChatCommandReplayedError | HandlerError<409> | undefined
> => {
  const receipt = (
    await tx
      .select({
        commandType: chatCommandReceipts.commandType,
        threadId: chatCommandReceipts.threadId,
        turnId: chatCommandReceipts.turnId,
      })
      .from(chatCommandReceipts)
      .where(eq(chatCommandReceipts.commandId, command.commandId))
      .limit(1)
  ).at(0);
  if (receipt === undefined) {
    return undefined;
  }
  return receipt.threadId === threadId && receipt.commandType === command.type
    ? new ChatCommandReplayedError({
        message: "The command was accepted earlier",
        turnId: receipt.turnId,
      })
    : commandConflict();
};

/** The receipt check of a request before it plans any work. */
export const readChatCommandReceiptOutcome = async ({
  safeDb,
  ...scope
}: ChatCommandScope & { safeDb: SafeDb }): Promise<
  Result<ChatCommandReplayedError | HandlerError<409> | undefined, SafeDbError>
> =>
  await safeDb(
    async (tx) => await chatCommandReceiptOutcomeOnTx({ ...scope, tx }),
  );

/**
 * Record that the command was accepted, in the transaction that accepted it.
 * An id another receipt already holds (another thread's, or a receipt this
 * member cannot see) aborts the transaction, so nothing the command did is
 * kept.
 */
export const insertChatCommandReceiptOnTx = async ({
  command,
  organizationId,
  threadId,
  turnId,
  tx,
  userId,
  workspaceId,
}: ChatCommandScope & {
  organizationId: SafeId<"organization">;
  turnId: SafeId<"chatTurn">;
  tx: Transaction;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
}): Promise<void> => {
  // audit: skip — a retry key of a command whose own writes are audited in this transaction
  const inserted = await tx
    .insert(chatCommandReceipts)
    .values({
      commandId: command.commandId,
      commandType: command.type,
      organizationId,
      threadId,
      turnId,
      userId,
      workspaceId,
    })
    .onConflictDoNothing()
    .returning({ commandId: chatCommandReceipts.commandId });
  if (inserted.length === 0) {
    throw commandConflict();
  }
};

/**
 * The answer to a replayed command: a 409 a client reads as success (see
 * `chatCommandOutcomeOf`), naming the turn the first attempt started or
 * continued in the turn header, so the client joins that turn.
 */
export const chatCommandReplayResponse = (
  replayed: ChatCommandReplayedError,
  headers: ResponseHeaders,
): HandlerError<409> => {
  headers[CHAT_TURN_ID_HEADER] = replayed.turnId;
  return new HandlerError({
    status: 409,
    code: CHAT_COMMAND_ERROR_CODE.replayed,
    message: "The command was accepted earlier; join its turn",
  });
};
