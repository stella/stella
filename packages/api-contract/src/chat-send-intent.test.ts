import { describe, expect, test } from "bun:test";

import {
  CHAT_CLOUD_RUN_TARGET,
  type ChatLocalHarnessReadiness,
  type ChatLocalRunReadiness,
  type ChatLocalRunTarget,
} from "./chat-run-target";
import {
  CHAT_MEMBER_SEND_ACTION,
  CHAT_SEND_INTENT,
  CHAT_TURN_STEERING,
  chatSendIntent,
  type ChatThreadSendState,
  chatTurnSteering,
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

const TARGET = {
  kind: "local",
  harness: "codex",
  model: "gpt",
  approvals: "ask",
  reasoningEffort: null,
} as const satisfies ChatLocalRunTarget;
const FOLDER = {
  desktopId: "11111111-1111-4111-8111-111111111111",
  linkId: "22222222-2222-4222-8222-222222222222",
  name: "Leases",
};
const OTHER_DESKTOP = "33333333-3333-4333-8333-333333333333";

const ready = (
  capabilities: Extract<
    ChatLocalHarnessReadiness,
    { state: "ready" }
  >["capabilities"],
): ChatLocalHarnessReadiness => ({
  id: "codex",
  state: "ready",
  version: "1.0.0",
  capabilities,
  approvalModes: ["ask"],
  models: [],
});

const readiness = (
  runners: { desktopId: string; harness: ChatLocalHarnessReadiness }[],
): ChatLocalRunReadiness => ({
  status: "enabled",
  maxApprovals: "full_auto",
  runners: runners.map(({ desktopId, harness }) => ({
    desktopId,
    connected: true,
    lastSeenAt: "2026-11-15T12:00:00Z",
    harnesses: [harness],
    linkedFolders: [],
  })),
});

describe("chatTurnSteering", () => {
  test("a cloud turn, or computers not read yet, take no message mid-turn", () => {
    expect(
      chatTurnSteering(
        CHAT_CLOUD_RUN_TARGET,
        readiness([{ desktopId: FOLDER.desktopId, harness: ready(["steer"]) }]),
      ),
    ).toBe(CHAT_TURN_STEERING.notSteerable);
    expect(chatTurnSteering(TARGET, undefined)).toBe(
      CHAT_TURN_STEERING.notSteerable,
    );
  });

  test("a local turn takes messages only when every computer it can run on reports steer", () => {
    const steers = { desktopId: FOLDER.desktopId, harness: ready(["steer"]) };
    const doesNot = { desktopId: OTHER_DESKTOP, harness: ready(["interrupt"]) };
    expect(chatTurnSteering(TARGET, readiness([steers]))).toBe(
      CHAT_TURN_STEERING.steerable,
    );
    expect(chatTurnSteering(TARGET, readiness([steers, doesNot]))).toBe(
      CHAT_TURN_STEERING.notSteerable,
    );
    // A linked folder's turn runs only on the folder's computer.
    expect(
      chatTurnSteering(
        { ...TARGET, folder: FOLDER },
        readiness([steers, doesNot]),
      ),
    ).toBe(CHAT_TURN_STEERING.steerable);
    expect(chatTurnSteering(TARGET, readiness([]))).toBe(
      CHAT_TURN_STEERING.notSteerable,
    );
  });
});
