import { expect, test } from "bun:test";

import { readChatDraftText } from "./use-chat-anonymize.logic";

test("reads the draft text of a live editor", () => {
  expect(
    readChatDraftText({ getText: () => "draft", isDestroyed: false }),
  ).toBe("draft");
});

test("reads an empty draft from a destroyed editor without touching it", () => {
  const editor = {
    getText: () => {
      throw new TypeError("schema is gone");
    },
    isDestroyed: true,
  };
  expect(readChatDraftText(editor)).toBe("");
});
