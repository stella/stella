import type { ChatClientState } from "@tanstack/ai-client";
import { panic } from "better-result";

import type { ChatSendMode } from "@stll/anonymize-chat";

import type {
  ChatEditApplyMode,
  DocxEditRepresentation,
} from "@/lib/chat-edit-mode";
import type {
  ChatSendMessageOptions,
  ChatUserMessageInput,
} from "@/routes/_protected.chat/-queries";

export const snapshotChatRequestOptions = ({
  docxEditRepresentation,
  editApplyMode,
  options,
  sendMode,
}: {
  docxEditRepresentation: DocxEditRepresentation | undefined;
  editApplyMode: ChatEditApplyMode | undefined;
  options: ChatSendMessageOptions | undefined;
  sendMode: ChatSendMode | undefined;
}): ChatSendMessageOptions | undefined => {
  if (sendMode === undefined && editApplyMode === undefined) {
    return options;
  }

  return {
    ...options,
    body: {
      ...(sendMode === undefined ? {} : { sendMode }),
      ...(editApplyMode === undefined ? {} : { editApplyMode }),
      ...(docxEditRepresentation === undefined
        ? {}
        : { docxEditRepresentation }),
      ...options?.body,
    },
  };
};

/**
 * A user message composed while a response was still streaming.
 * `useChatSession` holds these in a queue and dispatches them —
 * oldest first — once the turn finishes. `text` is the raw editor
 * HTML (rendered like any sent user message); `fileCount` lets the
 * pending bubble show an attachment hint without the view ever
 * touching the file payloads.
 */
export type QueuedChatMessage = {
  id: string;
  text: string;
  fileCount: number;
};

export type QueuedChatEntry = QueuedChatMessage & {
  /** Fully-built payload handed to TanStack ChatClient on dispatch. */
  message: ChatUserMessageInput;
  options?: ChatSendMessageOptions;
};

/**
 * Pull a display preview out of an outgoing chat payload. The SDK
 * accepts either raw text or multimodal content; queued bubbles only
 * need a text preview and attachment count.
 */
export const describeQueuedMessage = (
  message: ChatUserMessageInput,
): Pick<QueuedChatMessage, "fileCount" | "text"> => {
  if (typeof message.content === "string") {
    return { text: message.content, fileCount: 0 };
  }

  const textParts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      textParts.push(part.content);
    }
  }

  return {
    text: textParts.join("\n\n"),
    fileCount: message.content.filter((part) => part.type !== "text").length,
  };
};

/**
 * State backing `useChatSession`'s send queue. Owns exactly the fields
 * that used to be split across `isGeneratingRef`, `queueRef`,
 * `wasGeneratingRef`, and `conversationIdRef` — mirrored here so a
 * single `reduceSendQueue` call is the only way any of them changes.
 */
export type SendQueueState = {
  /** Id of the conversation the queue currently belongs to. */
  readonly conversationId: string;
  /**
   * Mirrors the runtime's live "a turn is in flight" signal, plus the
   * brief window right after a queued dispatch starts (set eagerly, ahead
   * of the runtime's own status catching up) and right after it fails
   * (cleared immediately so a retried send isn't blocked by a stale flag).
   */
  readonly isGenerating: boolean;
  /** Messages typed while `isGenerating` was true, oldest first. */
  readonly queue: readonly QueuedChatEntry[];
  /** `isGenerating` as of the previous turn-boundary check; used to detect the falling edge that ends a turn. */
  readonly wasGenerating: boolean;
};

export const createInitialSendQueueState = (
  conversationId: string,
): SendQueueState => ({
  conversationId,
  isGenerating: false,
  queue: [],
  wasGenerating: false,
});

/**
 * Every site in `useChatSession` that used to write one of the four
 * queue-related refs by hand. Each variant name traces back to the
 * call site it replaces (see `use-chat-session.ts`):
 *
 * - `message-enqueued` — `enqueueMessage`
 * - `queued-message-removed` — `removeQueuedMessage`
 * - `oldest-dispatch-started` — `takeOldestQueuedMessage` immediately
 *   followed by `dispatchQueuedMessage`'s eager `isGeneratingRef = true`.
 *   The two are merged into one atomic transition: in the original code
 *   every pop of the queue was always immediately followed by flipping
 *   `isGenerating`, with no await in between — so this event makes that
 *   pairing structural instead of a convention two call sites had to
 *   remember to uphold.
 * - `dispatch-failed` — `dispatchQueuedMessage`'s catch block
 * - `generation-status-synced` — the `isGeneratingRef.current = isGenerating` effect
 * - `turn-boundary-checked` — the queue-drain effect
 * - `conversation-switched` — both the inline guard at the top of
 *   `sendMessage` and the conversation-switch effect
 */
export type SendQueueEvent =
  | { type: "message-enqueued"; entry: QueuedChatEntry }
  | { type: "queued-message-removed"; id: string }
  | { type: "oldest-dispatch-started" }
  | { type: "dispatch-failed"; entry: QueuedChatEntry; requeue: boolean }
  | { type: "generation-status-synced"; isGenerating: boolean }
  | {
      type: "turn-boundary-checked";
      isGenerating: boolean;
      status: ChatClientState;
    }
  | { type: "conversation-switched"; conversationId: string };

export type SendQueueTransition = {
  state: SendQueueState;
  /**
   * The entry that just started dispatching, if this transition popped
   * one off the queue. Only `oldest-dispatch-started` and a
   * queue-draining `turn-boundary-checked` ever populate this; every
   * other event returns `null`. The caller is responsible for actually
   * sending it (the reducer only decides the state transition).
   */
  dispatchedEntry: QueuedChatEntry | null;
};

const startOldestDispatch = (state: SendQueueState): SendQueueTransition => {
  const [oldest, ...rest] = state.queue;
  if (!oldest) {
    return { state, dispatchedEntry: null };
  }
  return {
    state: { ...state, isGenerating: true, queue: rest },
    dispatchedEntry: oldest,
  };
};

/**
 * Pure transition for `useChatSession`'s send queue. Total over every
 * `SendQueueEvent` in every `SendQueueState` — there is no reachable
 * combination that falls through unhandled, so an exit path can no
 * longer update the generating flag without also updating the queue
 * (or vice versa).
 */
export const reduceSendQueue = (
  state: SendQueueState,
  event: SendQueueEvent,
): SendQueueTransition => {
  switch (event.type) {
    case "message-enqueued": {
      return {
        state: { ...state, queue: [...state.queue, event.entry] },
        dispatchedEntry: null,
      };
    }

    case "queued-message-removed": {
      return {
        state: {
          ...state,
          queue: state.queue.filter((entry) => entry.id !== event.id),
        },
        dispatchedEntry: null,
      };
    }

    case "oldest-dispatch-started": {
      return startOldestDispatch(state);
    }

    case "dispatch-failed": {
      return {
        state: {
          ...state,
          isGenerating: false,
          // A message-start failure means the send never got underway,
          // so it's safe (and necessary) to retry: put it back at the
          // front of the queue. Any other failure means the turn may
          // already have started server-side; re-queueing it would risk
          // a duplicate turn, so it's dropped instead — matching the
          // original `dispatchQueuedMessage` catch block, which only
          // requeued on `isChatMessageStartError`.
          queue: event.requeue ? [event.entry, ...state.queue] : state.queue,
        },
        dispatchedEntry: null,
      };
    }

    case "generation-status-synced": {
      return {
        state: { ...state, isGenerating: event.isGenerating },
        dispatchedEntry: null,
      };
    }

    case "turn-boundary-checked": {
      const finishedTurn = state.wasGenerating && !event.isGenerating;
      const next: SendQueueState = {
        ...state,
        wasGenerating: event.isGenerating,
      };
      // Hold the queue if the turn ended in error: firing every queued
      // message into a failing provider just burns quota and spams the
      // user with repeats of the same error. The next manual send (or a
      // successful regenerate) lifts the gate.
      if (!finishedTurn || event.status === "error") {
        return { state: next, dispatchedEntry: null };
      }
      return startOldestDispatch(next);
    }

    case "conversation-switched": {
      return {
        state: createInitialSendQueueState(event.conversationId),
        dispatchedEntry: null,
      };
    }

    default: {
      event satisfies never;
      return panic("Unhandled send-queue event");
    }
  }
};
