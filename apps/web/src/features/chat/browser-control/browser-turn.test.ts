import { describe, expect, test } from "bun:test";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";

import { browserTurnId, createTurnStopper } from "./browser-turn";

const user = (id: string) =>
  ({
    id,
    parts: [{ content: "Open the court site", type: "text" }],
    role: "user",
  }) satisfies PersistedChatMessage;

const assistant = (id: string, toolCallId: string) =>
  ({
    id,
    parts: [
      {
        arguments: "{}",
        id: toolCallId,
        name: "use-browser",
        state: "input-complete",
        type: "tool-call",
      },
    ],
    role: "assistant",
  }) satisfies PersistedChatMessage;

describe("browser turn id", () => {
  const thread: PersistedChatMessage[] = [
    user("user-1"),
    assistant("assistant-1", "call-1"),
    user("user-2"),
    assistant("assistant-2", "call-2"),
  ];

  test("is the persisted user message, so a rebuilt runtime charges the same turn", () => {
    // Two runtimes hydrated from the same persisted thread agree.
    expect(browserTurnId(structuredClone(thread), "call-2")).toBe("user-2");
    expect(browserTurnId(thread, "call-2")).toBe("user-2");
  });

  test("names the turn that holds the tool call, not merely the latest one", () => {
    expect(browserTurnId(thread, "call-1")).toBe("user-1");
    expect(browserTurnId(thread)).toBe("user-2");
    // A call not yet in the messages belongs to the latest turn.
    expect(browserTurnId(thread, "call-3")).toBe("user-2");
    expect(browserTurnId([])).toBe(null);
  });
});

describe("turn stopper", () => {
  test("a stopped turn's later calls start stopped; the next turn's do not", () => {
    const stopper = createTurnStopper();
    const running = stopper.signalFor("turn-1");

    stopper.stop("turn-1");

    expect(running.aborted).toBe(true);
    // An approved call of the stopped turn whose callback runs only now.
    expect(stopper.signalFor("turn-1").aborted).toBe(true);
    expect(stopper.signalFor("turn-2").aborted).toBe(false);
  });

  test("stopping a turn before any of its calls ran still stops them", () => {
    const stopper = createTurnStopper();
    stopper.stop("turn-1");

    expect(stopper.signalFor("turn-1").aborted).toBe(true);
  });
});
