import { describe, expect, test } from "bun:test";

import {
  collectAnonRestorations,
  getFollowingAssistantRestorations,
} from "@/components/chat/chat-thread-messages.logic";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";

const userMessage = (id: string, text = "hello"): PersistedChatMessage => ({
  id,
  parts: [{ type: "text", content: text }],
  role: "user",
});

const assistantMessage = (
  id: string,
  pairs: { placeholder: string; original: string }[] = [],
): PersistedChatMessage => ({
  id,
  metadata: pairs.length > 0 ? { anonRestorations: { pairs } } : undefined,
  parts: [{ type: "text", content: "reply" }],
  role: "assistant",
});

describe("collectAnonRestorations", () => {
  test("returns an empty array when the message has no anon metadata", () => {
    expect(collectAnonRestorations(assistantMessage("a1"))).toEqual([]);
  });

  test("de-dupes repeated placeholders, keeping the first original", () => {
    const message: PersistedChatMessage = {
      id: "a1",
      metadata: {
        anonRestorations: {
          pairs: [
            { placeholder: "[PERSON_1]", original: "Jane Doe" },
            { placeholder: "[PERSON_1]", original: "Jane Doe (stale)" },
            { placeholder: "[ORG_1]", original: "Acme Corp" },
          ],
        },
      },
      parts: [{ type: "text", content: "reply" }],
      role: "assistant",
    };

    expect(collectAnonRestorations(message)).toEqual([
      { placeholder: "[PERSON_1]", original: "Jane Doe" },
      { placeholder: "[ORG_1]", original: "Acme Corp" },
    ]);
  });
});

describe("getFollowingAssistantRestorations", () => {
  test("pairs a user message with its immediately following assistant reply", () => {
    const messages = [
      userMessage("u1"),
      assistantMessage("a1", [
        { placeholder: "[PERSON_1]", original: "Jane Doe" },
      ]),
    ];

    expect(getFollowingAssistantRestorations(messages, 0)).toEqual([
      { placeholder: "[PERSON_1]", original: "Jane Doe" },
    ]);
  });

  test("returns empty pairs for a trailing user message with no reply yet", () => {
    const messages = [
      userMessage("u1"),
      assistantMessage("a1", [
        { placeholder: "[PERSON_1]", original: "Jane Doe" },
      ]),
      userMessage("u2"),
    ];

    expect(getFollowingAssistantRestorations(messages, 2)).toEqual([]);
  });

  test("does not leak a later turn's restorations across two consecutive user messages", () => {
    // u1 never got a reply (e.g. a failed send left it stranded), then the
    // user sent u2 which did get answered. u1's lookup must stop at u2
    // instead of walking through to a2.
    const messages = [
      userMessage("u1", "first message, never answered"),
      userMessage("u2", "second message"),
      assistantMessage("a2", [
        { placeholder: "[PERSON_1]", original: "John Smith" },
      ]),
    ];

    expect(getFollowingAssistantRestorations(messages, 0)).toEqual([]);
    expect(getFollowingAssistantRestorations(messages, 1)).toEqual([
      { placeholder: "[PERSON_1]", original: "John Smith" },
    ]);
  });

  test("resolves against the surviving assistant message after a retry replaces the prior one", () => {
    // The backend's `replace-last-assistant` persistence plan (and the
    // client's `chat.reload()`) delete the stale assistant message rather
    // than leaving both around, so the array a retried turn actually
    // produces only ever has the single, final assistant message per turn.
    const messages = [
      userMessage("u1"),
      assistantMessage("a1-retried", [
        { placeholder: "[PERSON_1]", original: "Final Answer Person" },
      ]),
    ];

    expect(getFollowingAssistantRestorations(messages, 0)).toEqual([
      { placeholder: "[PERSON_1]", original: "Final Answer Person" },
    ]);
  });

  test("skips interleaved system/tool-call parts on the way to the assistant reply", () => {
    const systemMessage: PersistedChatMessage = {
      id: "s1",
      parts: [{ type: "text", content: "system notice" }],
      role: "system",
    };
    const messages = [
      userMessage("u1"),
      systemMessage,
      assistantMessage("a1", [
        { placeholder: "[ORG_1]", original: "Acme Corp" },
      ]),
    ];

    expect(getFollowingAssistantRestorations(messages, 0)).toEqual([
      { placeholder: "[ORG_1]", original: "Acme Corp" },
    ]);
  });

  test("returns empty pairs when the following assistant message carries no anon metadata", () => {
    const messages = [userMessage("u1"), assistantMessage("a1")];

    expect(getFollowingAssistantRestorations(messages, 0)).toEqual([]);
  });

  test("returns empty pairs for an out-of-range index", () => {
    const messages = [userMessage("u1")];

    expect(getFollowingAssistantRestorations(messages, 5)).toEqual([]);
  });
});
