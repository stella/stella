import { EventType } from "@tanstack/ai";
import { expect, test } from "bun:test";

import {
  buildWireSnapshot,
  unsafeFixture,
} from "@/api/tests/helpers/chat-fixtures";

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
  roles.classify(
    unsafeFixture(
      "Exhaustive wire-role matrix includes developer, activity and reasoning roles the native serializer cannot emit.",
      {
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
      },
    ),
  );
  roles.classify(buildWireSnapshot([]));
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
  roles.classify(
    buildWireSnapshot([{ id: "assistant", role: "user", content: "own" }]),
  );
  expect(
    roles.classify({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant",
      delta: "own",
    }).type,
  ).toBe("authored");
});

test.each(["assistant", "user"] as const)(
  "implicit text follows the current identity after relabeling %s",
  (initialRole) => {
    const role = initialRole === "assistant" ? "user" : "assistant";
    const expected = role === "user" ? "authored" : "generated";
    const identity = "current";
    for (const mode of ["live", "restored"] as const) {
      const roles = createRunMessageRoles();
      if (mode === "live") {
        roles.classify({
          type: EventType.TEXT_MESSAGE_START,
          messageId: identity,
          role: initialRole,
        });
        roles.classify(
          buildWireSnapshot([{ id: identity, role, content: "prior" }]),
        );
      } else {
        roles.restore([
          { messageId: identity, role: initialRole, current: true },
          { messageId: identity, role, current: false },
        ]);
      }
      roles.classify(buildWireSnapshot([]));
      roles.classify(
        buildWireSnapshot([
          { id: "other", role: initialRole, content: "prior" },
        ]),
      );
      expect(
        roles.classify({ type: EventType.TEXT_MESSAGE_CHUNK, delta: "text" }),
      ).toEqual({
        type: expected,
        identity: { type: "known", messageId: identity },
      });
    }
  },
);

test.each(["assistant", "user"] as const)(
  "anonymous %s attribution is unchanged by identified snapshot messages",
  (role) => {
    for (const mode of ["live", "restored"] as const) {
      const roles = createRunMessageRoles();
      if (mode === "live") {
        roles.classify({
          type: EventType.TEXT_MESSAGE_CHUNK,
          role,
          delta: "first",
        });
      } else {
        roles.restore([{ messageId: null, role, current: true }]);
      }
      roles.classify(
        buildWireSnapshot([
          {
            id: "other",
            role: role === "user" ? "assistant" : "user",
            content: "prior",
          },
        ]),
      );
      expect(
        roles.classify({ type: EventType.TEXT_MESSAGE_CHUNK, delta: "text" }),
      ).toEqual({
        type: role === "user" ? "authored" : "generated",
        identity: { type: "unknown" },
      });
    }
  },
);
