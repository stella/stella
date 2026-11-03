import { convertMessagesToModelMessages } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import {
  guardProviderHistory,
  withoutContentlessUserTurns,
} from "@/api/handlers/chat/provider-history";
import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";

const text = (content: string): ChatPart => ({ content, type: "text" });

const message = (
  id: string,
  role: ChatMessage["role"],
  parts: ChatPart[],
): ChatMessage => ({ id, parts, role });

const userContentOf = (messages: readonly ChatMessage[]) =>
  convertMessagesToModelMessages([...messages])
    .filter((modelMessage) => modelMessage.role === "user")
    .map((modelMessage) => modelMessage.content);

// A thread stored before the send endpoint refused empty messages: its first
// user message normalized to nothing and its turn failed with no answer.
describe("a stored user message with nothing to read", () => {
  const history: ChatMessage[] = [
    message("user-empty", "user", [text("")]),
    message("assistant-failed", "assistant", []),
    message("user-2", "user", [text("What does section 4 require?")]),
  ];

  test("never reaches the provider, so later turns of the thread still run", () => {
    // The fixture must reach the fault: as stored, the SDK hands the
    // provider a user message with no content at all.
    expect(userContentOf(history)).toContainEqual(null);

    const sent = guardProviderHistory({ messages: history, workspaceIds: [] });

    expect(userContentOf(sent)).toEqual(["What does section 4 require?"]);
    expect(sent.map(({ id }) => id)).toEqual(["user-2"]);
  });

  test("takes the replies to it along, keeping turns alternating", () => {
    const answered: ChatMessage[] = [
      message("user-1", "user", [text("Summarize the lease.")]),
      message("assistant-1", "assistant", [text("The lease runs 5 years.")]),
      message("user-blank", "user", [text(" \n")]),
      message("assistant-2", "assistant", [text("Could you clarify?")]),
      message("user-3", "user", [text("And the deposit?")]),
    ];
    expect(withoutContentlessUserTurns(answered).map(({ id }) => id)).toEqual([
      "user-1",
      "assistant-1",
      "user-3",
    ]);
  });

  test("an attachment alone is content and is kept", () => {
    const attached: ChatMessage[] = [
      message("user-file", "user", [
        text(" "),
        {
          type: "document",
          source: {
            type: "url",
            value: "https://files.example.test/lease.pdf",
            mimeType: "application/pdf",
          },
        },
      ]),
    ];
    expect(withoutContentlessUserTurns(attached)).toBe(attached);
  });

  test("leaves a thread whose user messages all have content alone", () => {
    const clean = history.slice(2);
    expect(withoutContentlessUserTurns(clean)).toBe(clean);
  });
});
