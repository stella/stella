import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { hasChatModelContent } from "./chat-message-content";

const WHITESPACE = fc.constantFrom(" ", "\n", "\t", "\r", " ", " ", "﻿");

describe("chat message model content", () => {
  test("a message of blank text parts has nothing for a model to read", () => {
    assertProperty(
      "a message of blank text parts has nothing for a model to read",
      fc.property(
        fc.array(fc.array(WHITESPACE).map((chars) => chars.join(""))),
        (texts) => {
          expect(
            hasChatModelContent(
              texts.map((content) => ({ type: "text", content })),
            ),
          ).toBe(false);
        },
      ),
    );
  });

  test("one visible character in any text part is content", () => {
    assertProperty(
      "one visible character in any text part is content",
      fc.property(
        fc.array(fc.array(WHITESPACE).map((chars) => chars.join(""))),
        fc.nat(),
        fc.constantFrom("a", "1", "§", "?", "č", "ل"),
        (texts, at, visible) => {
          const parts = texts.map((content) => ({
            type: "text",
            content,
          }));
          parts.splice(at % (parts.length + 1), 0, {
            type: "text",
            content: visible,
          });
          expect(hasChatModelContent(parts)).toBe(true);
        },
      ),
    );
  });

  test.each(["image", "document", "audio", "video"])(
    "an attachment (%s) is content without any text",
    (type) => {
      expect(
        hasChatModelContent([{ type: "text", content: " " }, { type }]),
      ).toBe(true);
    },
  );

  test("a message without parts has nothing for a model to read", () => {
    expect(hasChatModelContent([])).toBe(false);
  });
});
