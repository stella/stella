import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { nonPersistableChatParts } from "./__fixtures__/non-persistable-chat-parts";
import { toChatMessage } from "./stream-chat";

const textPart = fc.record({
  content: fc.string(),
  type: fc.constant("text"),
});
const streamedParts = fc.array(
  fc.oneof(textPart, fc.constantFrom(...nonPersistableChatParts)),
  { maxLength: 20 },
);

describe("streamed chat message conversion invariants", () => {
  test("returns a message exactly when at least one persistable part remains", () => {
    fc.assert(
      fc.property(streamedParts, (parts) => {
        const expectedParts = parts.filter((part) => part.type === "text");
        const message = toChatMessage({
          id: "assistant-message",
          role: "assistant",
          parts,
        });

        if (expectedParts.length === 0) {
          expect(message).toBeNull();
          return;
        }
        expect(message?.parts).toEqual(expectedParts);
      }),
      propertyConfig(),
    );
  });
});
