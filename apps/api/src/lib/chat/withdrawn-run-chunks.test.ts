import { EventType } from "@tanstack/ai";
import { expect, test } from "bun:test";

import type { ChatTurnTiming } from "@stll/api-contract/chat";

import { projectWithdrawnRunChunk } from "./withdrawn-run-chunks";

const timings = [
  { status: "finished", durationMs: 4250 },
  {
    status: "running",
    durationMs: 4250,
    startedAt: "2026-10-29T10:00:00.000Z",
    observedAt: "2026-10-29T10:00:01.000Z",
    elapsedMs: 1000,
  },
  null,
] satisfies (ChatTurnTiming | null)[];

test.each(timings)(
  "withdrawn END retains timing %j and timestamp",
  (turnTiming) => {
    expect(
      projectWithdrawnRunChunk(
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "answer",
          timestamp: 1_793_268_001_000,
          metadata: { turnTiming, note: "context" },
        },
        "Unavailable",
      ),
    ).toEqual({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "answer",
      timestamp: 1_793_268_001_000,
      metadata: { turnTiming },
    });
  },
);

test("withdrawn END projects only timing fields", () => {
  expect(
    projectWithdrawnRunChunk(
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "answer",
        metadata: {
          turnTiming: { status: "finished", durationMs: 42, note: "context" },
        },
      },
      "Unavailable",
    ),
  ).toEqual({
    type: EventType.TEXT_MESSAGE_END,
    messageId: "answer",
    metadata: { turnTiming: { status: "finished", durationMs: 42 } },
  });
});

test.each([
  undefined,
  { note: "context" },
  { turnTiming: { status: "finished", durationMs: "context" } },
  { turnTiming: { status: "finished", durationMs: -1 } },
  {
    turnTiming: {
      status: "running",
      durationMs: 0,
      elapsedMs: 1,
      startedAt: "context",
      observedAt: "context",
    },
  },
])("withdrawn END omits absent or invalid timing %j", (metadata) => {
  expect(
    projectWithdrawnRunChunk(
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "answer",
        ...(metadata === undefined ? {} : { metadata }),
      },
      "Unavailable",
    ),
  ).toEqual({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" });
});
