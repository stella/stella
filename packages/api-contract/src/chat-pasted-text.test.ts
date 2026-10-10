import { describe, expect, test } from "bun:test";

import { createChatPastedTextPart, isChatPastedTextPart } from "./chat";

describe("pasted text attachment contract", () => {
  test("retains the exact plain text through JSON serialization", () => {
    const content = " \r\n<p>literal &amp; text</p>\n\t§ 🗂 ";
    const part = createChatPastedTextPart(content);
    const serialized = JSON.stringify(part);
    const reloaded: unknown = JSON.parse(serialized);
    expect(isChatPastedTextPart(reloaded)).toBe(true);
    expect(reloaded).toEqual(part);
  });

  test("only marks text parts with the pasted text discriminator", () => {
    for (const part of [
      null,
      "text",
      { type: "text", content: "typed text" },
      { type: "text", content: "text", metadata: null },
      { type: "text", content: "text", metadata: { type: "other" } },
      { type: "text", content: 12, metadata: { type: "pasted_text" } },
      { type: "document", content: "text", metadata: { type: "pasted_text" } },
    ]) {
      expect(isChatPastedTextPart(part)).toBe(false);
    }
  });
});
