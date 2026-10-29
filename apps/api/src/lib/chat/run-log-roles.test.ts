import { EventType } from "@tanstack/ai";
import { expect, test } from "bun:test";

import { createRunMessageRoles } from "./run-log-roles";

test("unattributed text stays unknown across missing and unrelated boundaries", () => {
  const roles = createRunMessageRoles();
  expect(
    roles.classify({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "missing",
      delta: "own text",
    }).type,
  ).toBe("unknown");
  roles.classify({
    type: EventType.TEXT_MESSAGE_START,
    messageId: "user",
    role: "user",
  });
  expect(
    roles.classify({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "missing",
      delta: "text",
    }).type,
  ).toBe("unknown");
  roles.classify({
    type: EventType.TEXT_MESSAGE_START,
    messageId: "assistant",
    role: "assistant",
  });
  roles.classify({ type: EventType.TEXT_MESSAGE_END, messageId: "user" });
  expect(
    roles.classify({ type: EventType.TEXT_MESSAGE_CHUNK, delta: "answer" })
      .type,
  ).toBe("generated");
  roles.classify({ type: EventType.TEXT_MESSAGE_START, messageId: "unknown" });
  expect(
    roles.classify({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "unknown",
      delta: "text",
    }).type,
  ).toBe("unknown");
});

test("restored roles retain every open identity and clear only the matching end", () => {
  const roles = createRunMessageRoles();
  roles.restore([
    { messageId: "user", role: "user", current: false },
    { messageId: "assistant", role: "assistant", current: true },
    { messageId: "unknown", role: null, current: false },
  ]);
  for (const [messageId, role] of [
    ["user", "authored"],
    ["assistant", "generated"],
    ["unknown", "unknown"],
  ] as const) {
    expect(
      roles.classify({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: "text",
      }).type,
    ).toBe(role);
  }
  roles.classify({ type: EventType.TEXT_MESSAGE_END, messageId: "user" });
  expect(
    roles.classify({ type: EventType.TEXT_MESSAGE_CHUNK, delta: "answer" })
      .type,
  ).toBe("generated");
  roles.classify({ type: EventType.TEXT_MESSAGE_END, messageId: "assistant" });
  expect(
    roles.classify({ type: EventType.TEXT_MESSAGE_CHUNK, delta: "text" }).type,
  ).toBe("unknown");
});

test("transcript snapshots record every wire role and preserve labels they do not change", () => {
  const roles = createRunMessageRoles();
  roles.classify({
    type: EventType.MESSAGES_SNAPSHOT,
    messages: [
      { id: "user", role: "user", content: "own" },
      { id: "assistant", role: "assistant", content: "answer" },
      { id: "system", role: "system", content: "context" },
      { id: "developer", role: "developer", content: "context" },
      { id: "tool", role: "tool", toolCallId: "call", content: "result" },
      {
        id: "activity",
        role: "activity",
        activityType: "progress",
        content: {},
      },
      { id: "reasoning", role: "reasoning", content: "reasoning" },
    ],
  });
  roles.classify({ type: EventType.MESSAGES_SNAPSHOT, messages: [] });
  roles.classify({
    type: EventType.STATE_SNAPSHOT,
    snapshot: { messages: [{ id: "assistant", role: "user" }] },
  });
  roles.classify({
    type: "ACTIVITY_SNAPSHOT",
    messageId: "status",
    activityType: "progress",
    content: { messages: [{ id: "assistant", role: "user" }] },
  });
  for (const id of [
    "user",
    "assistant",
    "system",
    "developer",
    "tool",
    "activity",
    "reasoning",
  ]) {
    expect(
      roles.classify({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: id,
        delta: "text",
      }).type,
    ).toBe(id === "user" ? "authored" : "generated");
  }
  roles.classify({
    type: EventType.MESSAGES_SNAPSHOT,
    messages: [{ id: "assistant", role: "user", content: "own" }],
  });
  expect(
    roles.classify({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant",
      delta: "own",
    }).type,
  ).toBe("authored");
});
