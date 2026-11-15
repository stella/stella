import { describe, expect, test } from "bun:test";

import { CHAT_RUN_TARGET_KIND } from "./chat-run-target";
import {
  CHAT_MEMBER_SEND_ACTION,
  CHAT_SEND_INTENT,
  chatSendIntent,
  type ChatThreadSendState,
  isChatSteerOffered,
} from "./chat-send-intent";

const STATES: readonly ChatThreadSendState[] = [
  { type: "idle" },
  { type: "waiting_on_member" },
  ...Object.values(CHAT_RUN_TARGET_KIND).map(
    (runTarget) =>
      ({ type: "working", runTarget }) satisfies ChatThreadSendState,
  ),
];
const ACTIONS = Object.values(CHAT_MEMBER_SEND_ACTION);

describe("chatSendIntent", () => {
  test("never starts a turn while one works", () => {
    for (const state of STATES) {
      for (const action of ACTIONS) {
        if (state.type === "working") {
          expect(chatSendIntent(state, action)).not.toBe(
            CHAT_SEND_INTENT.start,
          );
        }
      }
    }
  });

  test("starts a turn on an idle thread, whatever the member did", () => {
    for (const action of ACTIONS) {
      expect(chatSendIntent({ type: "idle" }, action)).toBe(
        CHAT_SEND_INTENT.start,
      );
    }
  });

  test("a steer that cannot go does what a plain send does", () => {
    for (const state of STATES) {
      const steered = chatSendIntent(state, CHAT_MEMBER_SEND_ACTION.steer);
      if (steered !== CHAT_SEND_INTENT.steer) {
        expect(chatSendIntent(state, CHAT_MEMBER_SEND_ACTION.send)).toBe(
          steered,
        );
      }
    }
  });

  test("steers only on the explicit action, into a turn working on the member's computer", () => {
    for (const state of STATES) {
      for (const action of ACTIONS) {
        expect(chatSendIntent(state, action) === CHAT_SEND_INTENT.steer).toBe(
          action === CHAT_MEMBER_SEND_ACTION.steer &&
            state.type === "working" &&
            state.runTarget === CHAT_RUN_TARGET_KIND.local,
        );
      }
    }
  });

  test("a turn waiting on the member is never steered", () => {
    for (const action of ACTIONS) {
      expect(chatSendIntent({ type: "waiting_on_member" }, action)).not.toBe(
        CHAT_SEND_INTENT.steer,
      );
    }
  });

  test("offers the steer action only while a turn works on the member's computer", () => {
    for (const state of STATES) {
      expect(isChatSteerOffered(state)).toBe(
        state.type === "working" &&
          state.runTarget === CHAT_RUN_TARGET_KIND.local,
      );
    }
  });
});
