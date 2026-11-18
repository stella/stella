import * as v from "valibot";

import { CHAT_THREAD_NOT_FOUND_ERROR_CODE } from "@stll/api-contract";
import { CHAT_QUEUE_ERROR_CODE } from "@stll/api-contract/chat-queue";

import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const chatQueueThreadParams = v.object({
  threadId: resourceIdSchema("chatThread"),
});

export const chatQueuedMessageParams = v.object({
  threadId: resourceIdSchema("chatThread"),
  messageId: resourceIdSchema("chatMessage"),
});

export const chatThreadNotFound = () =>
  new HandlerError({
    status: 404,
    code: CHAT_THREAD_NOT_FOUND_ERROR_CODE,
    message: "Chat thread not found",
  });

export const queuedMessageNotFound = () =>
  new HandlerError({
    status: 404,
    code: CHAT_QUEUE_ERROR_CODE.notFound,
    message: "Queued message not found",
  });

export const queuedMessageSent = () =>
  new HandlerError({
    status: 409,
    code: CHAT_QUEUE_ERROR_CODE.sent,
    message: "The message was already sent from the queue",
  });

export const queuedMessageChanged = () =>
  new HandlerError({
    status: 409,
    code: CHAT_QUEUE_ERROR_CODE.changed,
    message: "The queued message changed; read it again",
  });

export const queuedMessageInlineFile = () =>
  new HandlerError({
    status: 422,
    code: CHAT_QUEUE_ERROR_CODE.inlineFile,
    message: "Upload a queued message's files before queueing it",
  });

export const queuedMessageInvalid = () =>
  new HandlerError({
    status: 422,
    code: CHAT_QUEUE_ERROR_CODE.invalid,
    message: "The queued message has a part a message cannot store",
  });
