import { describe, expect, test } from "bun:test";

import type { ChatPart } from "@/components/chat/chat-ui-tools";
import {
  getChatToolTitleKey,
  getUserMessageHtmlHistory,
  hasApprovedActiveDocxEditAwaitingClientOutput,
  isApprovalPart,
} from "@/components/chat/chat-ui-tools";

describe("chat tool titles", () => {
  test("maps Stella API tools to translation keys", () => {
    expect(getChatToolTitleKey("describe-stella-api")).toBe(
      "chat.tool.describe-stella-api",
    );
    expect(getChatToolTitleKey("run-stella-query")).toBe(
      "chat.tool.run-stella-query",
    );
  });

  test("preserves labels for legacy persisted tool parts", () => {
    expect(getChatToolTitleKey("describe-stella-function")).toBe(
      "chat.tool.describe-stella-function",
    );
    expect(getChatToolTitleKey("execute-typescript")).toBe(
      "chat.tool.execute-typescript",
    );
    expect(getChatToolTitleKey("search-across-matters")).toBe(
      "chat.tool.search-across-matters",
    );
    expect(getChatToolTitleKey("read-content-across-matters")).toBe(
      "chat.tool.read-content-across-matters",
    );
    expect(getChatToolTitleKey("read-contact")).toBe("chat.tool.read-contact");
  });

  test("uses the translated unknown fallback for unknown tools", () => {
    expect(getChatToolTitleKey("searchCaseLaw")).toBe("chat.tool.unknown");
  });
});

describe("isApprovalPart", () => {
  test("treats active DOCX edit tools as approval parts", () => {
    const part = {
      approval: { id: "approval-1" },
      input: { operations: [] },
      providerExecuted: false,
      state: "approval-requested",
      toolCallId: "tool-call-1",
      type: "tool-apply-active-docx-edits",
    } as ChatPart;

    expect(isApprovalPart(part)).toBe(true);
  });
});

describe("hasApprovedActiveDocxEditAwaitingClientOutput", () => {
  test("waits after approving an active DOCX edit until the client returns output", () => {
    expect(
      hasApprovedActiveDocxEditAwaitingClientOutput({
        messages: [
          {
            id: "message-1",
            parts: [
              {
                approval: { approved: true, id: "approval-1" },
                input: { operations: [] },
                providerExecuted: false,
                state: "approval-responded",
                toolCallId: "tool-call-1",
                type: "tool-apply-active-docx-edits",
              } as ChatPart,
            ],
            role: "assistant",
          },
        ],
      }),
    ).toBe(true);
  });

  test("does not wait when the user rejects an active DOCX edit", () => {
    expect(
      hasApprovedActiveDocxEditAwaitingClientOutput({
        messages: [
          {
            id: "message-1",
            parts: [
              {
                approval: { approved: false, id: "approval-1" },
                input: { operations: [] },
                providerExecuted: false,
                state: "approval-responded",
                toolCallId: "tool-call-1",
                type: "tool-apply-active-docx-edits",
              } as ChatPart,
            ],
            role: "assistant",
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("getUserMessageHtmlHistory", () => {
  test("returns user message HTML from newest to oldest", () => {
    expect(
      getUserMessageHtmlHistory([
        {
          id: "message-1",
          parts: [{ text: "Older prompt", type: "text" }],
          role: "user",
        },
        {
          id: "message-2",
          parts: [{ text: "Assistant response", type: "text" }],
          role: "assistant",
        },
        {
          id: "message-3",
          parts: [{ text: "Latest prompt", type: "text" }],
          role: "user",
        },
      ]),
    ).toEqual(["Latest prompt", "Older prompt"]);
  });

  test("skips user messages without text", () => {
    expect(
      getUserMessageHtmlHistory([
        {
          id: "message-1",
          parts: [{ text: "Reusable prompt", type: "text" }],
          role: "user",
        },
        {
          id: "message-2",
          parts: [
            {
              filename: "contract.pdf",
              mediaType: "application/pdf",
              type: "file",
              url: "https://example.com/contract.pdf",
            },
          ],
          role: "user",
        },
      ]),
    ).toEqual(["Reusable prompt"]);
  });

  test("trims history entries and skips whitespace-only text", () => {
    expect(
      getUserMessageHtmlHistory([
        {
          id: "message-1",
          parts: [{ text: "   ", type: "text" }],
          role: "user",
        },
        {
          id: "message-2",
          parts: [{ text: "\n<p>Clean prompt</p>\n", type: "text" }],
          role: "user",
        },
      ]),
    ).toEqual(["<p>Clean prompt</p>"]);
  });
});
