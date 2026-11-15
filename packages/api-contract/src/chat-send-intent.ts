import { panic } from "better-result";

import type { ChatRunTarget } from "./chat-run-target";

/**
 * What a chat thread is doing when the member sends, with where its turn
 * runs (stella's model path or the member's computer):
 * - `idle`: no turn runs.
 * - `working`: a turn answers.
 * - `waiting_on_member`: a turn stopped to wait on the member (an approval,
 *   a question).
 */
export type ChatThreadSendState =
  | { type: "idle" }
  | { type: "working"; runTarget: ChatRunTarget["kind"] }
  | { type: "waiting_on_member"; runTarget: ChatRunTarget["kind"] };

/**
 * What the member did: `send` is the composer's plain send (Enter, the send
 * button); `queue` is the explicit action that holds a message until the
 * turn ends (Cmd/Ctrl+Enter, the queue button).
 */
export const CHAT_MEMBER_SEND_ACTION = {
  send: "send",
  queue: "queue",
} as const;
export type ChatMemberSendAction =
  (typeof CHAT_MEMBER_SEND_ACTION)[keyof typeof CHAT_MEMBER_SEND_ACTION];

/**
 * Where the message goes: `start` a new turn, `queue` it behind the turn,
 * or `steer` the turn with it. A steer into a turn that waits on the member
 * first declines what the turn asked, so the turn goes on with the message.
 */
export const CHAT_SEND_INTENT = {
  start: "start",
  queue: "queue",
  steer: "steer",
} as const;
export type ChatSendIntent =
  (typeof CHAT_SEND_INTENT)[keyof typeof CHAT_SEND_INTENT];

/**
 * What a plain send does while a turn works: a turn on the member's
 * computer takes the message mid-turn; a cloud turn takes nothing mid-turn,
 * so the message waits for its end.
 */
const PLAIN_SEND_WHILE_WORKING = {
  cloud: CHAT_SEND_INTENT.queue,
  local: CHAT_SEND_INTENT.steer,
} as const satisfies Record<ChatRunTarget["kind"], ChatSendIntent>;

/**
 * What a plain send does while a turn waits on the member: on the member's
 * computer the shown approval or question is declined and the turn goes on
 * with the message; a cloud turn keeps its question, and the message waits
 * until the member answers and the turn ends.
 */
const PLAIN_SEND_WHILE_WAITING = {
  cloud: CHAT_SEND_INTENT.queue,
  local: CHAT_SEND_INTENT.steer,
} as const satisfies Record<ChatRunTarget["kind"], ChatSendIntent>;

const plainSendIntent = (state: ChatThreadSendState): ChatSendIntent => {
  switch (state.type) {
    case "idle":
      return CHAT_SEND_INTENT.start;
    case "working":
      return PLAIN_SEND_WHILE_WORKING[state.runTarget];
    case "waiting_on_member":
      return PLAIN_SEND_WHILE_WAITING[state.runTarget];
    default:
      state satisfies never;
      return panic("Unhandled thread send state");
  }
};

/**
 * Where a member's message goes, by what the thread is doing and what the
 * member did. Every client reads its send routing from here.
 *
 * On an idle thread every message starts a turn; nothing runs to queue
 * behind. Otherwise the queue action always queues, and a plain send goes
 * where `PLAIN_SEND_WHILE_WORKING` and `PLAIN_SEND_WHILE_WAITING` say.
 */
export const chatSendIntent = (
  state: ChatThreadSendState,
  action: ChatMemberSendAction,
): ChatSendIntent => {
  switch (action) {
    case CHAT_MEMBER_SEND_ACTION.send:
      return plainSendIntent(state);
    case CHAT_MEMBER_SEND_ACTION.queue:
      return state.type === "idle"
        ? CHAT_SEND_INTENT.start
        : CHAT_SEND_INTENT.queue;
    default:
      action satisfies never;
      return panic(`Unhandled send action: ${String(action)}`);
  }
};

/**
 * Whether the explicit queue action is offered in this state: only where it
 * does something a plain send does not.
 */
export const isChatQueueOffered = (state: ChatThreadSendState): boolean =>
  chatSendIntent(state, CHAT_MEMBER_SEND_ACTION.queue) !==
  chatSendIntent(state, CHAT_MEMBER_SEND_ACTION.send);
