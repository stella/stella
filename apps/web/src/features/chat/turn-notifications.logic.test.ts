import { describe, expect, test } from "bun:test";

import {
  getChatTurnNotification,
  getChatTurnPhase,
} from "@/features/chat/turn-notifications.logic";
import type {
  ChatTurnNotificationKind,
  ChatTurnPhase,
} from "@/features/chat/turn-notifications.logic";

const PHASE_SET = {
  "awaiting-user": true,
  failed: true,
  idle: true,
  running: true,
} as const satisfies Record<ChatTurnPhase, true>;
const PHASES = Object.keys(PHASE_SET).filter((phase): phase is ChatTurnPhase =>
  Object.hasOwn(PHASE_SET, phase),
);

describe("getChatTurnPhase", () => {
  test("a running turn is running whatever else holds", () => {
    for (const awaitingUser of [false, true]) {
      for (const hasError of [false, true]) {
        expect(
          getChatTurnPhase({ awaitingUser, hasError, isGenerating: true }),
        ).toBe("running");
      }
    }
  });

  test("a failure wins over a card the user could still answer", () => {
    expect(
      getChatTurnPhase({
        awaitingUser: true,
        hasError: true,
        isGenerating: false,
      }),
    ).toBe("failed");
  });

  test("a settled turn waits on the user or is idle", () => {
    expect(
      getChatTurnPhase({
        awaitingUser: true,
        hasError: false,
        isGenerating: false,
      }),
    ).toBe("awaiting-user");
    expect(
      getChatTurnPhase({
        awaitingUser: false,
        hasError: false,
        isGenerating: false,
      }),
    ).toBe("idle");
  });
});

describe("getChatTurnNotification", () => {
  const ENDS: Record<
    Exclude<ChatTurnPhase, "running">,
    ChatTurnNotificationKind
  > = {
    "awaiting-user": "needs-input",
    failed: "failed",
    idle: "reply-ready",
  };

  test("the end of a watched turn notifies a hidden page", () => {
    for (const [current, kind] of Object.entries(ENDS)) {
      expect(
        getChatTurnNotification({
          current: current as keyof typeof ENDS,
          pageVisible: false,
          previous: "running",
        }),
      ).toBe(kind);
    }
  });

  test("a page in sight is never notified", () => {
    for (const previous of [...PHASES, null]) {
      for (const current of PHASES) {
        expect(
          getChatTurnNotification({ current, pageVisible: true, previous }),
        ).toBeNull();
      }
    }
  });

  test("only a change away from running notifies", () => {
    for (const previous of [...PHASES, null]) {
      for (const current of PHASES) {
        const kind = getChatTurnNotification({
          current,
          pageVisible: false,
          previous,
        });
        const endsWatchedTurn = previous === "running" && current !== "running";
        expect(kind !== null).toBe(endsWatchedTurn);
      }
    }
  });

  test("a thread first seen settled does not notify", () => {
    for (const current of PHASES) {
      expect(
        getChatTurnNotification({
          current,
          pageVisible: false,
          previous: null,
        }),
      ).toBeNull();
    }
  });
});
