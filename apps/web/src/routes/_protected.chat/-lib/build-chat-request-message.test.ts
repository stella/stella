import { describe, expect, test } from "bun:test";
import { expectTypeOf } from "expect-type";

import type { SafeId } from "@/lib/safe-id";
import { buildChatRequestMessage } from "@/routes/_protected.chat/-lib/build-chat-request-message";

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
