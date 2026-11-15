import { panic } from "better-result";

import { CHAT_RUN_TARGET_KIND, type ChatRunTarget } from "./chat-run-target";

/**
 * What a chat thread is doing when the member sends:
 * - `idle`: no turn runs.
 * - `working`: a turn answers, on stella's model path or on the member's
 *   computer (`runTarget`).
 * - `waiting_on_member`: a turn stopped to wait on the member (an approval,
 *   a question).
 */
export type ChatThreadSendState =
  | { type: "idle" }
  | { type: "working"; runTarget: ChatRunTarget["kind"] }
  | { type: "waiting_on_member" };

/**
 * What the member did: `send` is the composer's plain send (Enter, the send
 * button); `steer` is the explicit action that hands a message to the turn
 * that works.
 */
export const CHAT_MEMBER_SEND_ACTION = {
  send: "send",
  steer: "steer",
} as const;
export type ChatMemberSendAction =
  (typeof CHAT_MEMBER_SEND_ACTION)[keyof typeof CHAT_MEMBER_SEND_ACTION];

/**
 * Where the message goes: `start` a new turn, `queue` it behind the turn,
 * or `steer` the turn that works with it.
 */
export const CHAT_SEND_INTENT = {
  start: "start",
  queue: "queue",
  steer: "steer",
} as const;
export type ChatSendIntent =
  (typeof CHAT_SEND_INTENT)[keyof typeof CHAT_SEND_INTENT];

/**
 * What a plain send does while a turn works: queue it behind the turn, as
 * before steering existed, until the product decision between queue and
 * steer is made. This is the one place that decision lands.
 */
const PLAIN_SEND_WHILE_WORKING: ChatSendIntent = CHAT_SEND_INTENT.queue;

/**
 * What a plain send does while a turn waits on the member: start a new turn,
 * which replaces the waiting one, as today. Whether it queues behind the
 * wait instead is the server queue's decision and lands here.
 */
const PLAIN_SEND_WHILE_WAITING: ChatSendIntent = CHAT_SEND_INTENT.start;

const plainSendIntent = (state: ChatThreadSendState): ChatSendIntent => {
  switch (state.type) {
    case "idle":
      return CHAT_SEND_INTENT.start;
    case "working":
      return PLAIN_SEND_WHILE_WORKING;
    case "waiting_on_member":
      return PLAIN_SEND_WHILE_WAITING;
    default:
      state satisfies never;
      return panic("Unhandled thread send state");
  }
};

/**
 * Where a member's message goes, by what the thread is doing and what the
 * member did. Every client reads its send routing from here.
 *
 * Only a turn that works on the member's computer can be steered: a cloud
 * turn takes no message mid-turn, and a turn waiting on the member is not
 * steered while it is undecided whether a message sent over an open
 * approval declines it. Where a steer cannot go, the steer action does what
 * a plain send does.
 */
export const chatSendIntent = (
  state: ChatThreadSendState,
  action: ChatMemberSendAction,
): ChatSendIntent => {
  switch (action) {
    case CHAT_MEMBER_SEND_ACTION.send:
      return plainSendIntent(state);
    case CHAT_MEMBER_SEND_ACTION.steer:
      return state.type === "working" &&
        state.runTarget === CHAT_RUN_TARGET_KIND.local
        ? CHAT_SEND_INTENT.steer
        : plainSendIntent(state);
    default:
      action satisfies never;
      return panic(`Unhandled send action: ${String(action)}`);
  }
};

/** Whether the explicit steer action is offered in this state. */
export const isChatSteerOffered = (state: ChatThreadSendState): boolean =>
  chatSendIntent(state, CHAT_MEMBER_SEND_ACTION.steer) ===
  CHAT_SEND_INTENT.steer;
