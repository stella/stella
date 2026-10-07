import type { UIMessage } from "@tanstack/ai-client";
import { expect, test } from "bun:test";

import { keepShownRejoinMessages } from "./chat-rejoin-messages";

const message = (content: string): UIMessage => ({
  id: "answer",
  role: "assistant",
  parts: [{ type: "text", content }],
});

test("rejoined assistant prefixes never make already shown text disappear", () => {
  const text = "Clause café\nالعربية";
  const shown = [message(text)];
  expect(keepShownRejoinMessages(shown, [])).toEqual(shown);
  for (let length = 0; length <= text.length; length += 1) {
    const replay = [message(text.slice(0, length))];
    expect(keepShownRejoinMessages(shown, replay)).toEqual(shown);
  }
  const caughtUp = [message(`${text} continues`)];
  expect(keepShownRejoinMessages(shown, caughtUp)).toEqual(caughtUp);
});
