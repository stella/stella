import { describe, expect, test } from "bun:test";

import { CHAT_RUN_TARGET_KIND } from "./chat-run-target";
import {
  CHAT_MEMBER_SEND_ACTION,
  CHAT_SEND_INTENT,
  chatSendIntent,
  type ChatThreadSendState,
  isChatQueueOffered,
} from "./chat-send-intent";

const RUN_TARGETS = Object.values(CHAT_RUN_TARGET_KIND);
const STATES: readonly ChatThreadSendState[] = [
  { type: "idle" },
  ...RUN_TARGETS.flatMap((runTarget) => [
    { type: "working", runTarget } satisfies ChatThreadSendState,
    { type: "waiting_on_member", runTarget } satisfies ChatThreadSendState,
  ]),
];
const ACTIONS = Object.values(CHAT_MEMBER_SEND_ACTION);

const isLocalTurn = (state: ChatThreadSendState) =>
  state.type !== "idle" && state.runTarget === CHAT_RUN_TARGET_KIND.local;

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

  test("a plain send steers a turn on the member's computer, working or waiting on them", () => {
    for (const state of STATES) {
      expect(
        chatSendIntent(state, CHAT_MEMBER_SEND_ACTION.send) ===
          CHAT_SEND_INTENT.steer,
      ).toBe(isLocalTurn(state));
    }
  });

  test("a cloud turn is never steered; a plain send waits for its end", () => {
    for (const state of STATES) {
      if (state.type !== "idle" && !isLocalTurn(state)) {
        for (const action of ACTIONS) {
          expect(chatSendIntent(state, action)).toBe(CHAT_SEND_INTENT.queue);
        }
      }
    }
  });

  test("only a plain send steers", () => {
    for (const state of STATES) {
      expect(chatSendIntent(state, CHAT_MEMBER_SEND_ACTION.queue)).not.toBe(
        CHAT_SEND_INTENT.steer,
      );
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
