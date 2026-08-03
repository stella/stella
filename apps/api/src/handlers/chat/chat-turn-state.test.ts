import { describe, expect, test } from "bun:test";

import {
  CHAT_TURN_STATUSES,
  type ChatTurnState,
  type ChatTurnTransition,
  planChatTurnTransition,
} from "@/api/handlers/chat/chat-turn-state";
import { toSafeId } from "@/api/lib/branded-types";

const id = toSafeId<"chatTurn">("11111111-1111-4111-8111-111111111111");
const threadId = toSafeId<"chatThread">("22222222-2222-4222-8222-222222222222");
const userMessageId = toSafeId<"chatMessage">(
  "33333333-3333-4333-8333-333333333333",
);
const assistantMessageId = toSafeId<"chatMessage">(
  "44444444-4444-4444-8444-444444444444",
);
const now = new Date("2026-08-03T10:00:00.000Z");
const leaseExpiresAt = new Date("2026-08-03T10:10:00.000Z");

const states = {
  accepted: {
    id,
    leaseExpiresAt,
    status: "accepted",
    threadId,
    userMessageId,
  },
  running: {
    executionId: "55555555-5555-4555-8555-555555555555",
    id,
    leaseExpiresAt,
    status: "running",
    threadId,
    userMessageId,
  },
  "awaiting-user": {
    assistantMessageId,
    id,
    interaction: { toolCallId: "ask-1", type: "ask-user" },
    status: "awaiting-user",
    threadId,
    userMessageId,
  },
  completed: {
    assistantMessageId,
    completedAt: now,
    id,
    status: "completed",
    threadId,
    userMessageId,
  },
  failed: {
    failedAt: now,
    failure: { code: "provider-error", retryable: true },
    id,
    status: "failed",
    threadId,
    userMessageId,
  },
  cancelled: {
    cancelledAt: now,
    id,
    reason: "user-stop",
    status: "cancelled",
    threadId,
    userMessageId,
  },
  interrupted: {
    id,
    interruptedAt: now,
    reason: "timeout",
    status: "interrupted",
    threadId,
    userMessageId,
  },
} as const satisfies Record<(typeof CHAT_TURN_STATUSES)[number], ChatTurnState>;

const transitions = {
  start: {
    executionId: "55555555-5555-4555-8555-555555555555",
    leaseExpiresAt,
    type: "start",
  },
  "await-user": {
    assistantMessageId,
    interaction: { toolCallId: "ask-1", type: "ask-user" },
    type: "await-user",
  },
  complete: { assistantMessageId, completedAt: now, type: "complete" },
  fail: {
    failedAt: now,
    failure: { code: "provider-error", retryable: true },
    type: "fail",
  },
  cancel: { cancelledAt: now, reason: "user-stop", type: "cancel" },
  interrupt: { interruptedAt: now, reason: "timeout", type: "interrupt" },
  resume: {
    executionId: "66666666-6666-4666-8666-666666666666",
    leaseExpiresAt,
    type: "resume",
  },
} as const satisfies Record<ChatTurnTransition["type"], ChatTurnTransition>;

const allowedTransitions = {
  accepted: {
    start: true,
    "await-user": false,
    complete: false,
    fail: true,
    cancel: true,
    interrupt: true,
    resume: false,
  },
  running: {
    start: false,
    "await-user": true,
    complete: true,
    fail: true,
    cancel: true,
    interrupt: true,
    resume: false,
  },
  "awaiting-user": {
    start: false,
    "await-user": false,
    complete: false,
    fail: false,
    cancel: true,
    interrupt: false,
    resume: true,
  },
  completed: {
    start: false,
    "await-user": false,
    complete: false,
    fail: false,
    cancel: false,
    interrupt: false,
    resume: false,
  },
  failed: {
    start: false,
    "await-user": false,
    complete: false,
    fail: false,
    cancel: false,
    interrupt: false,
    resume: false,
  },
  cancelled: {
    start: false,
    "await-user": false,
    complete: false,
    fail: false,
    cancel: false,
    interrupt: false,
    resume: false,
  },
  interrupted: {
    start: false,
    "await-user": false,
    complete: false,
    fail: false,
    cancel: false,
    interrupt: false,
    resume: false,
  },
} as const satisfies Record<
  (typeof CHAT_TURN_STATUSES)[number],
  Record<ChatTurnTransition["type"], boolean>
>;

describe("chat turn lifecycle", () => {
  test("accepts exactly the declared state transitions", () => {
    for (const status of CHAT_TURN_STATUSES) {
      for (const transition of Object.values(transitions)) {
        const result = planChatTurnTransition(states[status], transition);
        expect(result.type).toBe(
          allowedTransitions[status][transition.type] ? "applied" : "rejected",
        );
      }
    }
  });

  test("removes execution ownership when the turn awaits a user", () => {
    const result = planChatTurnTransition(
      states.running,
      transitions["await-user"],
    );

    expect(result).toEqual({
      state: states["awaiting-user"],
      type: "applied",
    });
  });

  test("keeps interruption distinct from failure and cancellation", () => {
    expect(
      planChatTurnTransition(states.running, transitions.interrupt),
    ).toEqual({
      state: states.interrupted,
      type: "applied",
    });
  });

  test("never reopens a terminal turn", () => {
    for (const status of [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ] as const) {
      for (const transition of Object.values(transitions)) {
        expect(planChatTurnTransition(states[status], transition)).toEqual({
          from: status,
          transition: transition.type,
          type: "rejected",
        });
      }
    }
  });
});
