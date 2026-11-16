import type { Result } from "better-result";
import * as v from "valibot";

import {
  CHAT_QUEUE_HOLD_REASONS,
  CHAT_SEND_QUEUES_INSTEAD_CODE,
  type ChatSendQueuesInsteadCode,
} from "@stll/api-contract/chat-queue";
import { DESKTOP_RUNNER_MAX_INPUT_TEXT_LENGTH } from "@stll/api-contract/desktop-runner";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";
import type { queuedChatSend } from "@/state/chat-stream";

/**
 * A thread's queue on the server: the messages that wait for the thread to
 * be free, sent one by one by the server, and what holds them. The routes
 * are the web's (`apps/web/src/features/chat/chat-queue.ts`).
 */

const queueItemSchema = v.object({
  id: v.string(),
  revision: v.number(),
  preview: v.string(),
  attachmentCount: v.number(),
  sendMode: v.string(),
});

const queueSchema = v.object({
  items: v.array(queueItemSchema),
  hold: v.nullable(
    v.object({
      reason: v.picklist(CHAT_QUEUE_HOLD_REASONS),
      queuedMessageId: v.nullable(v.string()),
    }),
  ),
});

export type ChatQueue = v.InferOutput<typeof queueSchema>;
export type ChatQueueItem = ChatQueue["items"][number];

/** How a message goes when its text is anonymized first (`sendMode`). */
const CHAT_SEND_MODE_ANONYMIZED = "anonymized";

const doneSchema = v.object({});

type QueueRequest = {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly threadId: string;
};

const queuePath = (threadId: string) =>
  `/v1/chat/threads/${encodeURIComponent(threadId)}/queue`;

const messagePath = (threadId: string, messageId: string) =>
  `${queuePath(threadId)}/${encodeURIComponent(messageId)}`;

const isQueuesInsteadCode = (code: string): code is ChatSendQueuesInsteadCode =>
  Object.values(CHAT_SEND_QUEUES_INSTEAD_CODE).some((known) => known === code);

/** Whether the server refused a send so that it is queued instead. */
export const queuesInstead = (error: ApiError): boolean =>
  error._tag === "ApiRequestError" &&
  error.code !== undefined &&
  isQueuesInsteadCode(error.code);

export const readChatQueue = async ({
  fetch,
  source,
  threadId,
}: QueueRequest): Promise<Result<ChatQueue, ApiError>> =>
  await requestApi({
    fetch,
    path: queuePath(threadId),
    schema: queueSchema,
    source,
  });

/** Queue `send` under its message's own id; a repeat answers the same item. */
export const enqueueChatMessage = async ({
  fetch,
  send,
  source,
  threadId,
}: QueueRequest & {
  readonly send: ReturnType<typeof queuedChatSend>;
}): Promise<Result<unknown, ApiError>> =>
  await requestApi({
    fetch,
    path: queuePath(threadId),
    body: { send },
    schema: v.object({ item: queueItemSchema }),
    source,
  });

const wholeMessageSchema = v.object({
  message: v.object({ parts: v.array(v.unknown()) }),
  revision: v.number(),
});

/** One queued message whole, with the revision read. */
export const readQueuedChatMessage = async ({
  fetch,
  messageId,
  source,
  threadId,
}: QueueRequest & { readonly messageId: string }): Promise<
  Result<v.InferOutput<typeof wholeMessageSchema>, ApiError>
> =>
  await requestApi({
    fetch,
    path: messagePath(threadId, messageId),
    schema: wholeMessageSchema,
    source,
  });

/** Remove a queued message at the revision read (409 once edited since). */
export const removeQueuedChatMessage = async ({
  fetch,
  messageId,
  revision,
  source,
  threadId,
}: QueueRequest & {
  readonly messageId: string;
  readonly revision: number;
}): Promise<Result<unknown, ApiError>> =>
  await requestApi({
    fetch,
    method: "DELETE",
    path: `${messagePath(threadId, messageId)}?revision=${String(revision)}`,
    schema: v.object({ message: v.unknown() }),
    source,
  });

/** Move a queued message before `beforeId`, or to the end with `null`. */
export const moveQueuedChatMessage = async ({
  beforeId,
  fetch,
  messageId,
  source,
  threadId,
}: QueueRequest & {
  readonly beforeId: string | null;
  readonly messageId: string;
}): Promise<Result<unknown, ApiError>> =>
  await requestApi({
    fetch,
    path: `${messagePath(threadId, messageId)}/move`,
    body: { beforeId },
    schema: doneSchema,
    source,
  });

/**
 * Send a queued message next, now: a running turn is stopped, a turn that
 * waits on the person is ended, a held queue is released.
 */
export const sendQueuedChatMessageNow = async ({
  fetch,
  messageId,
  source,
  threadId,
}: QueueRequest & { readonly messageId: string }): Promise<
  Result<unknown, ApiError>
> =>
  await requestApi({
    fetch,
    method: "POST",
    path: `${messagePath(threadId, messageId)}/send-now`,
    schema: doneSchema,
    source,
  });

/** Pause (`pause`) or resume (`resume`) the thread's queue. */
export const holdChatQueue = async ({
  fetch,
  hold,
  source,
  threadId,
}: QueueRequest & { readonly hold: "pause" | "resume" }): Promise<
  Result<unknown, ApiError>
> =>
  await requestApi({
    fetch,
    method: hold === "pause" ? "PUT" : "DELETE",
    path: `${queuePath(threadId)}/hold`,
    schema: doneSchema,
    source,
  });

const textPartSchema = v.object({
  type: v.literal("text"),
  content: v.string(),
});

/**
 * The text of a queued message made only of text, as the composer holds
 * it; `null` for one with any other part (a file, a pasted text), which the
 * phone neither steers nor edits.
 */
export const queuedMessageText = (parts: readonly unknown[]): string | null => {
  const texts: string[] = [];
  for (const part of parts) {
    const parsed = v.safeParse(textPartSchema, part);
    if (!parsed.success) {
      return null;
    }
    texts.push(parsed.output.content);
  }
  const text = texts.join("\n\n").trim();
  return text === "" ? null : text;
};

/**
 * The text a running turn may be handed of a queued message: plain text,
 * not sent anonymized, within what one steer takes; else `null`, and the
 * message is sent next instead.
 */
export const steerableQueuedText = ({
  parts,
  sendMode,
}: {
  readonly parts: readonly unknown[];
  readonly sendMode: string;
}): string | null => {
  const text = queuedMessageText(parts);
  return sendMode === CHAT_SEND_MODE_ANONYMIZED ||
    text === null ||
    text.length > DESKTOP_RUNNER_MAX_INPUT_TEXT_LENGTH
    ? null
    : text;
};
