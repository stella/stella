import { describe, expect, test, expectTypeOf } from "bun:test";

import { buildChatRequestMessage } from "@/features/chat/lib/build-chat-request-message";
import type { SafeId } from "@/lib/safe-id";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

describe("chat request message building", () => {
  test("uses a stella chat message id for text-only TanStack sends", async () => {
    const message = await buildChatRequestMessage({
      files: [],
      html: "<p>ahoj</p>",
    });

    expectTypeOf(message.id).toEqualTypeOf<SafeId<"chatMessage">>();
    expect(message.id).toMatch(UUID_PATTERN);
    expect(message.id.startsWith("msg-")).toBe(false);
    expect(message.content).toBe("<p>ahoj</p>");
  });
});

test("sends pasted text as a native text attachment without normalizing it", async () => {
  const text = " \r\n<b>Literal text</b>\n\t  ";
  const message = await buildChatRequestMessage({
    files: [{ type: "pasted_text", id: "paste", text }],
    html: "<p>Read this</p>",
  });
  expect(message.content).toEqual([
    { type: "text", content: "<p>Read this</p>" },
    { type: "text", content: text, metadata: { type: "pasted_text" } },
  ]);
  const attachmentOnly = await buildChatRequestMessage({
    files: [{ type: "pasted_text", id: "paste", text }],
    html: "",
  });
  expect(attachmentOnly.content).toEqual([
    { type: "text", content: text, metadata: { type: "pasted_text" } },
  ]);
});
