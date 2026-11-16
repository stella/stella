import { queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { CHAT_THREAD_NOT_FOUND_ERROR_CODE } from "@stll/api-contract";
import type { QueuedMessageFilesOnRemove } from "@stll/api-contract/chat-queue";

import { chatKeys } from "@/features/chat/chat-query-contract";
import { api } from "@/lib/api";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import { toAPIError, unwrapApiResponse } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

/**
 * The messages a member queued in a chat, kept by the server: it sends the
 * first one as the member once the chat's turn has ended and nothing holds
 * the queue. Read again when the user stream says a queue changed
 * (`USER_EVENT_READ.CHAT_QUEUES`), from this tab, another one or the
 * server's own sender, and on every turn's start or end.
 */

type ChatQueueThread = {
  activeOrganizationId: string;
  userId: string;
  threadId: string;
};

const queueRoutes = (threadId: string) =>
  api.chat.threads({ threadId: toSafeId<"chatThread">(threadId) }).queue;

const queuedMessageRoutes = (threadId: string, messageId: string) =>
  queueRoutes(threadId)({ messageId: toSafeId<"chatMessage">(messageId) });

const fetchChatQueue = async (threadId: string, signal: AbortSignal) =>
  await queueRoutes(threadId).get({ fetch: { signal } });

export type ChatQueue = NonNullable<
  Awaited<ReturnType<typeof fetchChatQueue>>["data"]
>;
export type ChatQueueItem = ChatQueue["items"][number];
type ChatQueueHold = NonNullable<ChatQueue["hold"]>;

/** A thread the server does not store yet (a new chat before its first
 *  message is accepted) has nothing queued. */
const NO_QUEUE: ChatQueue = { items: [], hold: null };

const readChatQueue = async (
  threadId: string,
  signal: AbortSignal,
): Promise<ChatQueue> => {
  const response = await fetchChatQueue(threadId, signal);
  if (
    response.error !== null &&
    toAPIError(response.error).code === CHAT_THREAD_NOT_FOUND_ERROR_CODE
  ) {
    return NO_QUEUE;
  }
  return unwrapApiResponse(response);
};

export const chatQueueOptions = ({
  activeOrganizationId,
  userId,
  threadId,
}: ChatQueueThread) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: chatKeys.queue(activeOrganizationId, userId, threadId),
      queryFn: async ({ signal }): Promise<ChatQueue> =>
        await readChatQueue(threadId, signal),
    }),
    // Read again on the user stream's `CHAT_QUEUES` and after this page's own
    // queue writes; no resource event names a queue.
    { type: "independent" },
  );

export type QueuedChatSend = Parameters<
  ReturnType<typeof queueRoutes>["post"]
>[0]["send"];

/** Queue `send` at the end of the thread's queue, under its message id. */
export const enqueueChatMessage = async (
  threadId: string,
  send: QueuedChatSend,
) =>
  await invokeAppOnlyWrite("chat.queue.create", async () =>
    unwrapApiResponse(await queueRoutes(threadId).post({ send })),
  );

/** A queued message whole, as it was queued (the queue's read shows only
 *  its beginning). */
export const readQueuedChatMessage = async (
  threadId: string,
  messageId: string,
) => unwrapApiResponse(await queuedMessageRoutes(threadId, messageId).get());

/** Remove a queued message at the `revision` read, deleting or keeping the
 *  files its queueing stored (`files`); answers it as it was queued, or
 *  `null` once it was no longer queued. */
export const removeQueuedChatMessage = async ({
  files,
  messageId,
  revision,
  threadId,
}: {
  files: QueuedMessageFilesOnRemove;
  messageId: string;
  revision: number;
  threadId: string;
}) =>
  await invokeAppOnlyWrite("chat.queue.delete", async () =>
    unwrapApiResponse(
      await queuedMessageRoutes(threadId, messageId).delete(undefined, {
        query: { files, revision },
      }),
    ),
  );

/** Move a queued message before `beforeId`, or to the end with `null`. */
export const moveQueuedChatMessage = async ({
  beforeId,
  messageId,
  threadId,
}: {
  beforeId: string | null;
  messageId: string;
  threadId: string;
}) =>
  await invokeAppOnlyWrite("chat.queue.move", async () =>
    unwrapApiResponse(
      await queuedMessageRoutes(threadId, messageId).move.post({
        beforeId: beforeId === null ? null : toSafeId<"chatMessage">(beforeId),
      }),
    ),
  );

/**
 * Send a queued message next, now: it moves first and the queue is released;
 * a turn that runs is stopped, and one that waits on the member is ended.
 */
export const sendQueuedChatMessageNow = async (
  threadId: string,
  messageId: string,
) =>
  await invokeAppOnlyWrite("chat.queue.send-now", async () =>
    unwrapApiResponse(
      await queuedMessageRoutes(threadId, messageId)["send-now"].post(),
    ),
  );

/** Pause the thread's queue: nothing queued is sent until it is resumed. */
export const pauseChatQueue = async (threadId: string) =>
  await invokeAppOnlyWrite("chat.queue.hold.set", async () =>
    unwrapApiResponse(await queueRoutes(threadId).hold.put()),
  );

/** Release whatever holds the thread's queue. */
export const resumeChatQueue = async (threadId: string) =>
  await invokeAppOnlyWrite("chat.queue.hold.delete", async () =>
    unwrapApiResponse(await queueRoutes(threadId).hold.delete()),
  );

/**
 * Show a queue change at once: the server's answer, or the user stream's
 * re-read, then corrects it.
 */
export const updateCachedChatQueue = ({
  queryClient,
  thread,
  update,
}: {
  queryClient: QueryClient;
  thread: ChatQueueThread;
  update: (queue: ChatQueue) => ChatQueue;
}): void => {
  queryClient.setQueryData(chatQueueOptions(thread).queryKey, (queue) =>
    queue === undefined ? queue : update(queue),
  );
};

/** What a member can do with the chat's queue and each queued message. */
type ChatQueueActions = {
  /** Take a message back into the composer to write it again. */
  edit: (id: string) => void;
  move: (id: string, direction: "down" | "up") => void;
  pause: () => void;
  remove: (id: string) => void;
  /** Send `id` now over a turn that waits on the member, ending what it
   *  waits on; only after the member confirmed it. */
  replaceWith: (id: string) => void;
  resume: () => void;
  /** Send `id` now; `confirm` when that ends what a turn waits on, which
   *  the member confirms first (`replaceWith`). */
  sendNow: (id: string) => "confirm" | "done";
};

/** The chat's queue as a transcript shows it, with what can be done to it. */
export type ChatQueueView = {
  actions: ChatQueueActions;
  hold: ChatQueueHold | null;
  items: readonly ChatQueueItem[];
};
