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
