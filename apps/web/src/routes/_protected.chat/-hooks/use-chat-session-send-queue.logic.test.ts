import type { ChatClientState } from "@tanstack/ai-client";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import {
  createInitialSendQueueState,
  reduceSendQueue,
  snapshotChatRequestOptions,
  type QueuedChatEntry,
  type SendQueueState,
} from "@/routes/_protected.chat/-hooks/use-chat-session-send-queue.logic";
import type { ChatUserMessageInput } from "@/routes/_protected.chat/-queries";

const CONVERSATION_ID = "conversation-1";

describe("snapshotChatRequestOptions", () => {
  test("captures automatic DOCX preferences when a turn is enqueued", () => {
    expect(
      snapshotChatRequestOptions({
        docxEditRepresentation: "tracked-changes",
        editApplyMode: "auto",
        options: undefined,
        sendMode: "anonymized",
      }),
    ).toEqual({
      body: {
        docxEditRepresentation: "tracked-changes",
        editApplyMode: "auto",
        sendMode: "anonymized",
      },
    });
  });

  test("captures manual mode without inheriting a representation", () => {
    expect(
      snapshotChatRequestOptions({
        docxEditRepresentation: undefined,
        editApplyMode: "manual",
        options: undefined,
        sendMode: undefined,
      }),
    ).toEqual({ body: { editApplyMode: "manual" } });
  });
});

const makeMessage = (id: string): ChatUserMessageInput => ({
  id: toSafeId<"chatMessage">(id),
  content: `message ${id}`,
});

const makeEntry = (id: string): QueuedChatEntry => ({
  id,
  text: `message ${id}`,
  fileCount: 0,
  message: makeMessage(id),
});

/**
 * `useChatSession` fires two separate effects off the same render's
 * `isGenerating` value: one mirrors it straight into the state
 * (`generation-status-synced`) and one runs the finished-turn/error-gate
 * check (`turn-boundary-checked`), in that order. Tests that need to
 * simulate "a render happened with the runtime reporting X" replay both,
 * exactly like the hook does, instead of calling either event alone.
 */
const applyRenderTick = (
  state: SendQueueState,
  isGenerating: boolean,
  status: ChatClientState,
) => {
  const synced = reduceSendQueue(state, {
    type: "generation-status-synced",
    isGenerating,
  });
  return reduceSendQueue(synced.state, {
    type: "turn-boundary-checked",
    isGenerating,
    status,
  });
};

describe("reduceSendQueue", () => {
  test("idle state: dispatching the oldest message on an empty queue is a no-op", () => {
    // "Normal send while idle" never touches the queue at all in
    // `useChatSession` (it calls `sendChatMessage` directly). The queue's
    // own idle behavior is that popping from an empty queue changes
    // nothing and hands back no entry to dispatch.
    const state = createInitialSendQueueState(CONVERSATION_ID);

    const result = reduceSendQueue(state, { type: "oldest-dispatch-started" });

    expect(result.dispatchedEntry).toBeNull();
    expect(result.state).toBe(state);
  });

  test("enqueue while generating, then dispatch once the turn finishes", () => {
    let state = createInitialSendQueueState(CONVERSATION_ID);

    // A turn starts.
    state = applyRenderTick(state, true, "streaming").state;
    expect(state.isGenerating).toBe(true);

    // A message typed mid-stream is queued, not sent.
    const entry = makeEntry("a");
    const enqueueResult = reduceSendQueue(state, {
      type: "message-enqueued",
      entry,
    });
    state = enqueueResult.state;
    expect(enqueueResult.dispatchedEntry).toBeNull();
    expect(state.queue).toEqual([entry]);

    // The turn finishes: the falling edge dispatches the oldest queued
    // message and flips `isGenerating` back on for it.
    const finishResult = applyRenderTick(state, false, "ready");
    state = finishResult.state;

    expect(finishResult.dispatchedEntry).toEqual(entry);
    expect(state.queue).toEqual([]);
    expect(state.isGenerating).toBe(true);
  });

  test("a turn ending in error holds the queue instead of draining it", () => {
    let state = createInitialSendQueueState(CONVERSATION_ID);
    state = applyRenderTick(state, true, "streaming").state;
    const entry = makeEntry("a");
    state = reduceSendQueue(state, { type: "message-enqueued", entry }).state;

    const result = applyRenderTick(state, false, "error");

    expect(result.dispatchedEntry).toBeNull();
    expect(result.state.queue).toEqual([entry]);
    expect(result.state.isGenerating).toBe(false);
  });

  test("dispatch failure from a message-start error requeues the entry at the front", () => {
    const waiting = makeEntry("waiting");
    const state: SendQueueState = {
      ...createInitialSendQueueState(CONVERSATION_ID),
      isGenerating: true,
      queue: [waiting],
    };
    const failedEntry = makeEntry("failed");

    const result = reduceSendQueue(state, {
      type: "dispatch-failed",
      entry: failedEntry,
      requeue: true,
    });

    // The failed send never got underway, so it goes back to the front —
    // ahead of anything queued while it was in flight.
    expect(result.state.queue).toEqual([failedEntry, waiting]);
    expect(result.state.isGenerating).toBe(false);
  });

  test("dispatch failure without a message-start error drops the entry (matches `dispatchQueuedMessage`'s catch block, which only requeues on `isChatMessageStartError`)", () => {
    const waiting = makeEntry("waiting");
    const state: SendQueueState = {
      ...createInitialSendQueueState(CONVERSATION_ID),
      isGenerating: true,
      queue: [waiting],
    };
    const failedEntry = makeEntry("failed");

    const result = reduceSendQueue(state, {
      type: "dispatch-failed",
      entry: failedEntry,
      requeue: false,
    });

    // The failed message is not put back: a non-start error means the
    // turn may already have begun server-side, so retrying it here would
    // risk sending it twice.
    expect(result.state.queue).toEqual([waiting]);
    expect(result.state.isGenerating).toBe(false);
  });

  test("conversation switch clears the queue and the generating flags", () => {
    const state: SendQueueState = {
      conversationId: CONVERSATION_ID,
      isGenerating: true,
      queue: [makeEntry("a"), makeEntry("b")],
      wasGenerating: true,
    };

    const result = reduceSendQueue(state, {
      type: "conversation-switched",
      conversationId: "conversation-2",
    });

    expect(result.state).toEqual({
      conversationId: "conversation-2",
      isGenerating: false,
      queue: [],
      wasGenerating: false,
    });
    expect(result.dispatchedEntry).toBeNull();
  });

  test("two generation-finished events in a row dispatch only once", () => {
    let state = createInitialSendQueueState(CONVERSATION_ID);
    state = applyRenderTick(state, true, "streaming").state;
    const entry = makeEntry("a");
    state = reduceSendQueue(state, { type: "message-enqueued", entry }).state;

    const first = applyRenderTick(state, false, "ready");
    // Simulate the effect re-running (e.g. a re-render with unrelated
    // state changes) with the same "not generating" reading, before
    // anything else has changed `isGenerating` again. `wasGenerating` was
    // already dropped to `false` by the first run, so this can't re-fire
    // a second dispatch of the same (already-popped) turn.
    const second = reduceSendQueue(first.state, {
      type: "turn-boundary-checked",
      isGenerating: false,
      status: "ready",
    });

    expect(first.dispatchedEntry).toEqual(entry);
    expect(second.dispatchedEntry).toBeNull();
    expect(second.state.queue).toEqual([]);
    expect(second.state.isGenerating).toBe(true);
  });

  test("generation-status-synced mirrors the runtime's flag without touching the queue", () => {
    const entry = makeEntry("a");
    const state: SendQueueState = {
      ...createInitialSendQueueState(CONVERSATION_ID),
      queue: [entry],
    };

    const result = reduceSendQueue(state, {
      type: "generation-status-synced",
      isGenerating: true,
    });

    expect(result.state.isGenerating).toBe(true);
    expect(result.state.queue).toBe(state.queue);
    expect(result.dispatchedEntry).toBeNull();
  });

  test("removing a queued message by id drops only that entry", () => {
    const first = makeEntry("a");
    const second = makeEntry("b");
    const state: SendQueueState = {
      ...createInitialSendQueueState(CONVERSATION_ID),
      queue: [first, second],
    };

    const result = reduceSendQueue(state, {
      type: "queued-message-removed",
      id: first.id,
    });

    expect(result.state.queue).toEqual([second]);
  });

  test("removing a non-existent id is a safe no-op", () => {
    const entry = makeEntry("a");
    const state: SendQueueState = {
      ...createInitialSendQueueState(CONVERSATION_ID),
      queue: [entry],
    };

    const result = reduceSendQueue(state, {
      type: "queued-message-removed",
      id: "does-not-exist",
    });

    expect(result.state.queue).toEqual([entry]);
  });

  test("dispatching the oldest of several queued messages preserves FIFO order", () => {
    const first = makeEntry("a");
    const second = makeEntry("b");
    const state: SendQueueState = {
      ...createInitialSendQueueState(CONVERSATION_ID),
      queue: [first, second],
    };

    const result = reduceSendQueue(state, { type: "oldest-dispatch-started" });

    expect(result.dispatchedEntry).toEqual(first);
    expect(result.state.queue).toEqual([second]);
    expect(result.state.isGenerating).toBe(true);
  });
});
