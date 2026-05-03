import { describe, expect, test } from "bun:test";

import type { ChatPart } from "@/components/chat/chat-ui-tools";
import {
  getChatToolTitleKey,
  hasApprovedActiveDocxEditAwaitingClientOutput,
  isApprovalPart,
} from "@/components/chat/chat-ui-tools";

describe("chat tool titles", () => {
  test("maps current cross-matter tools to translation keys", () => {
    expect(getChatToolTitleKey("search-across-matters")).toBe(
      "chat.tool.search-across-matters",
    );
    expect(getChatToolTitleKey("read-content-across-matters")).toBe(
      "chat.tool.read-content-across-matters",
    );
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
