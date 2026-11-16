import { panic } from "better-result";

import {
  CHAT_RUN_TARGET_KIND,
  type ChatLocalRunReadiness,
  type ChatRunTarget,
} from "./chat-run-target";
import { DESKTOP_RUNNER_HARNESS_STATE } from "./desktop-runner";

/**
 * Whether the thread's turn takes a message mid-turn: `steerable` on a
 * computer whose harness reports `steer`; `not_steerable` for a cloud turn,
 * which takes nothing mid-turn, and for a harness that does not report it.
 */
export const CHAT_TURN_STEERING = {
  steerable: "steerable",
  notSteerable: "not_steerable",
} as const;
export type ChatTurnSteering =
  (typeof CHAT_TURN_STEERING)[keyof typeof CHAT_TURN_STEERING];

/**
 * Whether a turn on `target` takes a message mid-turn, from what the
 * member's computers last reported. The API routes a turn to any connected
 * computer with the harness ready (only the folder's computer for a linked
 * folder), so every such report must list `steer`. Readiness not read yet
 * counts as not steerable: the message then waits, and nothing is declined.
 */
export const chatTurnSteering = (
  target: ChatRunTarget,
  readiness: ChatLocalRunReadiness | undefined,
): ChatTurnSteering => {
  if (
    target.kind === CHAT_RUN_TARGET_KIND.cloud ||
    readiness?.status !== "enabled"
  ) {
    return CHAT_TURN_STEERING.notSteerable;
  }
  const ready = readiness.runners
    .filter(
      (runner) =>
        runner.connected &&
        (target.folder === undefined ||
          runner.desktopId === target.folder.desktopId),
    )
    .flatMap((runner) =>
      runner.harnesses.flatMap((report) =>
        report.id === target.harness &&
        report.state === DESKTOP_RUNNER_HARNESS_STATE.ready
          ? [report.capabilities]
          : [],
      ),
    );
  return ready.length > 0 &&
    ready.every((capabilities) => capabilities.includes("steer"))
    ? CHAT_TURN_STEERING.steerable
    : CHAT_TURN_STEERING.notSteerable;
};

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
