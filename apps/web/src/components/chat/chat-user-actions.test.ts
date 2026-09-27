import { describe, expect, test } from "bun:test";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import {
  canForkAssistantMessage,
  canRetryAssistantMessage,
  isChatTurnGenerating,
} from "@/components/chat/chat-user-actions";
import type { UnnamedChatSessionHandler } from "@/components/chat/chat-user-actions";

const message = (
  id: string,
  role: "assistant" | "user",
): PersistedChatMessage => ({ id, parts: [], role });

describe("chat user actions", () => {
  test("names every session handler a control calls", () => {
    // A session handler no action names fails to compile here.
    const unnamed: [UnnamedChatSessionHandler] extends [never]
      ? []
      : [UnnamedChatSessionHandler] = [];
    expect(unnamed).toEqual([]);
  });
});

describe("assistant message actions", () => {
  const messages = [
    message("u1", "user"),
    message("a1", "assistant"),
    message("u2", "user"),
    message("a2", "assistant"),
  ];

  test("offer retry on the latest answer only, once no turn runs", () => {
    expect(
      ["a1", "a2"].flatMap((messageId) =>
        [false, true].map((isGenerating) =>
          canRetryAssistantMessage({ isGenerating, messageId, messages }),
        ),
      ),
    ).toEqual([false, false, true, false]);
  });

  test("offer a fork on every answer but a running latest one", () => {
    expect(
      ["a1", "a2"].flatMap((messageId) =>
        [false, true].map((isGenerating) =>
          canForkAssistantMessage({ isGenerating, messageId, messages }),
        ),
      ),
    ).toEqual([true, true, true, false]);
  });
});

describe("a running turn", () => {
  test("keeps running while the server settles its stop", () => {
    const idle = {
      hasError: false,
      messages: [message("u1", "user"), message("a1", "assistant")],
      requestActive: false,
      sessionGenerating: false,
    };
    // Until the stop settles the server refuses a new message, so the
    // composer queues it instead of sending it.
    expect(
      (["idle", "pending", "failed"] as const).map((stopStatus) =>
        isChatTurnGenerating({ ...idle, stopStatus }),
      ),
    ).toEqual([false, true, false]);
  });
});
