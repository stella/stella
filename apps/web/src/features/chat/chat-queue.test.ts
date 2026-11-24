import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import {
  type ChatQueue,
  type ChatQueueItem,
  chatQueueOptions,
  enqueueAndCacheChatMessage,
} from "@/features/chat/chat-queue";
import { toSafeId } from "@/lib/safe-id";

const THREAD = {
  activeOrganizationId: "00000000-0000-7000-8000-00000000ffff",
  userId: "00000000-0000-7000-8000-00000000aaaa",
  threadId: "00000000-0000-7000-8000-00000000c0de",
};

const MESSAGE_ID = "018f0000-0000-7000-8000-0000000000c1";

const item = (revision: number, preview: string): ChatQueueItem => ({
  attachmentCount: 0,
  createdAt: "2026-11-24T19:05:43.000Z",
  id: toSafeId<"chatMessage">(MESSAGE_ID),
  position: 1,
  preview,
  revision,
  runTarget: null,
  sendMode: CHAT_SEND_MODE.rawOverride,
});

/** The server's answer to the queue write: the message at its first revision. */
const STORED = item(0, "Only the Prague leases, please.");

const queueKey = chatQueueOptions(THREAD).queryKey;

describe("a message queued to hand to a running turn", () => {
  test("is the one the write stored when the page has not read the queue yet", async () => {
    const queryClient = new QueryClient();
    expect(queryClient.getQueryData(queueKey)).toBeUndefined();

    const queued = await enqueueAndCacheChatMessage({
      enqueue: async () => await Promise.resolve({ item: STORED }),
      queryClient,
      thread: THREAD,
    });

    // The hand-off has its id and revision even with no queue read to look
    // them up in.
    expect(queued).toEqual(STORED);
    expect(queryClient.getQueryData(queueKey)).toBeUndefined();
  });

  test("keeps the revision it wrote when a read already holds a newer one edited elsewhere", async () => {
    const queryClient = new QueryClient();
    // Another tab edited the message before this write answered, and the
    // realtime read of the queue landed first.
    const edited = item(1, "All leases, Brno included.");
    const read: ChatQueue = { hold: null, items: [edited] };
    queryClient.setQueryData(queueKey, read);

    const queued = await enqueueAndCacheChatMessage({
      enqueue: async () => await Promise.resolve({ item: STORED }),
      queryClient,
      thread: THREAD,
    });

    // The turn is handed revision 0 with the text written at revision 0; the
    // server refuses it as changed, so the edit stays queued for its turn.
    expect(queued.revision).toBe(0);
    // The queue still shows the edit.
    expect(queryClient.getQueryData(queueKey)).toEqual(read);
  });

  test("shows at once in a queue the page has read", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queueKey, { hold: null, items: [] });

    await enqueueAndCacheChatMessage({
      enqueue: async () => await Promise.resolve({ item: STORED }),
      queryClient,
      thread: THREAD,
    });

    expect(queryClient.getQueryData(queueKey)).toEqual({
      hold: null,
      items: [STORED],
    });
  });
});
