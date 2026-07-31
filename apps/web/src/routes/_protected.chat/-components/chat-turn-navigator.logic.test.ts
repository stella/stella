import { describe, expect, test } from "bun:test";

import { userMessageFallbackText } from "@/components/chat/chat-thread-messages.logic";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import { buildChatTurnNavigationItems } from "@/routes/_protected.chat/-components/chat-turn-navigator.logic";

const textMessage = (
  id: string,
  role: "assistant" | "system" | "user",
  content: string,
): PersistedChatMessage => ({
  id,
  parts: [{ type: "text", content }],
  role,
});

describe("chat turn navigation items", () => {
  test("pairs each user prompt with the start of its assistant response", () => {
    const items = buildChatTurnNavigationItems(
      [
        textMessage("orphan", "assistant", "Earlier response"),
        textMessage("user-1", "user", "<p>Review the filing</p>"),
        textMessage("system-1", "system", "Internal status"),
        textMessage("assistant-1", "assistant", "The filing is complete."),
        textMessage("user-2", "user", "Check the deadline"),
      ],
      userMessageFallbackText,
    );

    expect(items).toEqual([
      {
        assistantPreview: "The filing is complete.",
        id: "user-1",
        userAttachmentCount: 0,
        userPreview: "Review the filing",
      },
      {
        assistantPreview: null,
        id: "user-2",
        userAttachmentCount: 0,
        userPreview: "Check the deadline",
      },
    ]);
  });

  test("counts file-only prompts and keeps previews bounded", () => {
    const longResponse = "answer ".repeat(100);
    const fileOnlyMessage: PersistedChatMessage = {
      id: "user-files",
      parts: [
        {
          type: "document",
          source: {
            type: "url",
            value: "stella://file::file_test123",
            mimeType: "application/pdf",
          },
        },
      ],
      role: "user",
    };

    const [item] = buildChatTurnNavigationItems(
      [
        fileOnlyMessage,
        textMessage("assistant-files", "assistant", longResponse),
      ],
      userMessageFallbackText,
    );

    expect(item?.userPreview).toBeNull();
    expect(item?.userAttachmentCount).toBe(1);
    expect(item?.assistantPreview?.endsWith("…")).toBe(true);
    expect(item?.assistantPreview?.length).toBe(281);
  });

  test("shows only the ten most recent turns", () => {
    const messages = Array.from({ length: 12 }, (_, index) => {
      const number = index + 1;
      return [
        textMessage(`user-${number}`, "user", `Question ${number}`),
        textMessage(`assistant-${number}`, "assistant", `Answer ${number}`),
      ];
    }).flat();

    const items = buildChatTurnNavigationItems(
      messages,
      userMessageFallbackText,
    );

    expect(items).toHaveLength(10);
    expect(items.map(({ id }) => id)).toEqual([
      "user-3",
      "user-4",
      "user-5",
      "user-6",
      "user-7",
      "user-8",
      "user-9",
      "user-10",
      "user-11",
      "user-12",
    ]);
  });
});
