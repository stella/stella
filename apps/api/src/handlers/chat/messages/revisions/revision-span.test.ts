import { describe, expect, test } from "bun:test";

import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { isRevisionEditSpanValid } from "@/api/handlers/chat/messages/revisions/revision-span";

const original = toPersistedChatMessageContentV3({
  data: [
    { type: "text", content: "Hello" },
    {
      type: "tool-call",
      id: "call",
      name: "mcp__external__search",
      arguments: "{}",
      state: "complete",
    },
    { type: "text", content: "World" },
  ],
});

describe("answer edit part boundaries", () => {
  test.each([
    { first: "Hi", last: "elloWorld", start: 0, end: 1, valid: false },
    { first: "Haello", last: "World", start: 0, end: 1, valid: true },
    { first: "Hello", last: "Wxrld", start: 6, end: 7, valid: true },
    { first: "Hell", last: "oWxrld", start: 6, end: 7, valid: false },
    { first: "HellX", last: "Xorld", start: 4, end: 6, valid: true },
    { first: "Hello", last: "World", start: 0, end: 11, valid: false },
  ])(
    "$first / $last at $start..$end has validity $valid",
    ({ first, last, start, end, valid }) => {
      const candidateParts = original.data.map((part, index) =>
        part.type === "text"
          ? { ...part, content: index === 0 ? first : last }
          : part,
      );
      expect(
        isRevisionEditSpanValid({
          originalParts: original.data,
          candidateParts,
          edit: { type: "format", format: "bold", start, end },
        }),
      ).toBe(valid);
    },
  );

  test("an edit preserves non-text parts at their original position", () => {
    expect(
      isRevisionEditSpanValid({
        originalParts: original.data,
        candidateParts: [
          ...original.data.slice(1),
          ...original.data.slice(0, 1),
        ],
        edit: { type: "format", format: "bold", start: 0, end: 10 },
      }),
    ).toBe(false);
  });
});
