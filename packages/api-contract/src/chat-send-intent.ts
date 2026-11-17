import { panic } from "better-result";
import * as v from "valibot";

/**
 * Whether the thread's running turn takes a message mid-turn, as the server
 * knows it from the turn's own run: `steerable` while it runs on a computer
 * whose harness reports `steer`; `not_steerable` for a cloud turn, which
 * takes nothing mid-turn, for a harness that does not report it, and for a
 * turn with no run. Clients read it, never derive it.
 */
export const CHAT_TURN_STEERING = {
  steerable: "steerable",
  notSteerable: "not_steerable",
} as const;
export type ChatTurnSteering =
  (typeof CHAT_TURN_STEERING)[keyof typeof CHAT_TURN_STEERING];

export const chatTurnSteeringSchema = v.picklist([
  CHAT_TURN_STEERING.steerable,
  CHAT_TURN_STEERING.notSteerable,
]);

/**
 * The CUSTOM stream event that says whether the turn takes a message
 * mid-turn (`ChatTurnSteering`), sent once when a read of a turn on the
 * member's computer starts. A turn that sends none (a cloud turn) takes
 * nothing mid-turn. A rejoined stream replays it from the run log; a thread
 * opened later reads it from its page (`activeTurnSteering`).
 */
export const CHAT_TURN_STEERING_EVENT = "stella.turn.steering";

export const chatTurnSteeringEventSchema = v.strictObject({
  steering: chatTurnSteeringSchema,
});
export type ChatTurnSteeringEvent = v.InferOutput<
  typeof chatTurnSteeringEventSchema
>;

/**
 * What a chat thread is doing when the member sends, with whether its turn
 * takes a message mid-turn (`ChatTurnSteering`):
 * - `idle`: no turn runs.
 * - `working`: a turn answers.
 * - `waiting_on_member`: a turn stopped to wait on the member (an approval,
 *   a question).
 */
export type ChatThreadSendState =
  | { type: "idle" }
  | { type: "working"; steering: ChatTurnSteering }
  | { type: "waiting_on_member"; steering: ChatTurnSteering };

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
 * first declines the approval it shows, so the turn goes on with the message.
 */
export const CHAT_SEND_INTENT = {
  start: "start",
  queue: "queue",
  steer: "steer",
} as const;
export type ChatSendIntent =
  (typeof CHAT_SEND_INTENT)[keyof typeof CHAT_SEND_INTENT];

/**
 * What a plain send does while a turn works: a turn that takes a message
 * mid-turn is steered with it; any other turn (a cloud turn among them)
 * keeps the message until its end.
 */
const PLAIN_SEND_WHILE_WORKING = {
  steerable: CHAT_SEND_INTENT.steer,
  not_steerable: CHAT_SEND_INTENT.queue,
} as const satisfies Record<ChatTurnSteering, ChatSendIntent>;

/**
 * What a plain send does while a turn waits on the member: a turn that takes
 * a message mid-turn has the shown approval declined and goes on with the
 * message (a client never dismisses a question for it, since that stops the
 * turn; the message then waits behind the question); any other turn keeps
 * what it asked, and the message waits until the member answers and the
 * turn ends, so nothing is declined for a message the turn could not take.
 */
const PLAIN_SEND_WHILE_WAITING = {
  steerable: CHAT_SEND_INTENT.steer,
  not_steerable: CHAT_SEND_INTENT.queue,
} as const satisfies Record<ChatTurnSteering, ChatSendIntent>;

const plainSendIntent = (state: ChatThreadSendState): ChatSendIntent => {
  switch (state.type) {
    case "idle":
      return CHAT_SEND_INTENT.start;
    case "working":
      return PLAIN_SEND_WHILE_WORKING[state.steering];
    case "waiting_on_member":
      return PLAIN_SEND_WHILE_WAITING[state.steering];
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
