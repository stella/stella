import { describe, expect, test } from "bun:test";

import {
  CHAT_MEMBER_SEND_ACTION,
  CHAT_SEND_INTENT,
  CHAT_TURN_STEERING,
  chatSendIntent,
  type ChatThreadSendState,
  isChatQueueOffered,
} from "./chat-send-intent";

const STEERINGS = Object.values(CHAT_TURN_STEERING);
const STATES: readonly ChatThreadSendState[] = [
  { type: "idle" },
  ...STEERINGS.flatMap((steering) => [
    { type: "working", steering } satisfies ChatThreadSendState,
    { type: "waiting_on_member", steering } satisfies ChatThreadSendState,
  ]),
];
const ACTIONS = Object.values(CHAT_MEMBER_SEND_ACTION);

const isSteerableTurn = (state: ChatThreadSendState) =>
  state.type !== "idle" && state.steering === CHAT_TURN_STEERING.steerable;

describe("chatSendIntent", () => {
  test("starts a turn on an idle thread, and only there", () => {
    for (const state of STATES) {
      for (const action of ACTIONS) {
        expect(chatSendIntent(state, action) === CHAT_SEND_INTENT.start).toBe(
          state.type === "idle",
        );
      }
    }
  });

  test("the queue action queues behind any turn", () => {
    for (const state of STATES) {
      if (state.type !== "idle") {
        expect(chatSendIntent(state, CHAT_MEMBER_SEND_ACTION.queue)).toBe(
          CHAT_SEND_INTENT.queue,
        );
      }
    }
  });

  test("a plain send steers a turn that takes messages, working or waiting on the member", () => {
    for (const state of STATES) {
      expect(
        chatSendIntent(state, CHAT_MEMBER_SEND_ACTION.send) ===
          CHAT_SEND_INTENT.steer,
      ).toBe(isSteerableTurn(state));
    }
  });

  test("a turn that takes no message mid-turn is never steered; a plain send waits for its end", () => {
    for (const state of STATES) {
      if (state.type !== "idle" && !isSteerableTurn(state)) {
        for (const action of ACTIONS) {
          expect(chatSendIntent(state, action)).toBe(CHAT_SEND_INTENT.queue);
        }
      }
    }
  });

  test("offers the queue action exactly where a plain send steers", () => {
    for (const state of STATES) {
      expect(isChatQueueOffered(state)).toBe(
        chatSendIntent(state, CHAT_MEMBER_SEND_ACTION.send) ===
          CHAT_SEND_INTENT.steer,
      );
    }
  });
});
