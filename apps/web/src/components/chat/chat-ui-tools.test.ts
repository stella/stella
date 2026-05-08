import { describe, expect, test } from "bun:test";

import type { ChatPart } from "@/components/chat/chat-ui-tools";
import {
  getChatToolTitleKey,
  getApprovalToolName,
  getToolApprovalGrant,
  getUserMessageHtmlHistory,
  hasApprovalResponseAwaitingModelStep,
  hasApprovedActiveDocxEditAwaitingClientOutput,
  hasRunningToolCallInLatestAssistantMessage,
  isApprovalPart,
  isPublicOfficialChatToolName,
  isToolApprovedByGrant,
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
  test("distinguishes official public lookup tools from other public tools", () => {
    expect(isPublicOfficialChatToolName("ares_lookup_company")).toBe(true);
    expect(isPublicOfficialChatToolName("ares_search_companies")).toBe(true);
    expect(isPublicOfficialChatToolName("mcp__salvia__search_decisions")).toBe(
      false,
    );
  });

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

  test("treats external MCP tools as approval parts", () => {
    const part = {
      approval: { id: "approval-1" },
      input: { query: "civil code" },
      providerExecuted: false,
      state: "approval-requested",
      toolCallId: "tool-call-1",
      type: "tool-mcp__salvia__search_decisions",
    };

    expect(isApprovalPart(part)).toBe(true);
  });

  test("treats dynamic external MCP approval requests as approval parts", () => {
    const part = {
      approval: { id: "approval-1" },
      input: { query: "protección de datos" },
      state: "approval-requested",
      toolCallId: "tool-call-1",
      toolName: "mcp__legal-data-hunter__search",
      type: "dynamic-tool",
    };

    expect(isApprovalPart(part)).toBe(true);
    if (!isApprovalPart(part)) {
      throw new Error("Expected dynamic MCP approval part");
    }

    expect(getApprovalToolName(part)).toBe("mcp__legal-data-hunter__search");
  });

  test("treats legacy external native API approval requests as approval parts", () => {
    const part = {
      approval: { id: "approval-1" },
      input: { ico: "27082440" },
      providerExecuted: false,
      state: "approval-requested",
      toolCallId: "tool-call-1",
      type: "tool-ares_lookup_company",
    };

    expect(isApprovalPart(part)).toBe(true);
  });

  test("does not treat public ARES output as an approval part", () => {
    const part = {
      input: { ico: "27082440" },
      output: { ico: "27082440", name: "Alza.cz a.s." },
      state: "output-available",
      toolCallId: "tool-call-1",
      type: "tool-ares_lookup_company",
    };

    expect(isApprovalPart(part)).toBe(false);
  });

  test("does not treat ask-user as an approval part", () => {
    const part = {
      input: { questions: [] },
      output: undefined,
      state: "input-available",
      toolCallId: "tool-call-1",
      type: "tool-ask-user",
    };

    expect(isApprovalPart(part)).toBe(false);
  });
});

describe("tool approval grants", () => {
  test("treats external MCP approvals as connector-level grants", () => {
    const grants = new Set([
      getToolApprovalGrant("mcp__salvia__search_decisions"),
    ]);

    expect(isToolApprovedByGrant(grants, "mcp__salvia__fetch_document")).toBe(
      true,
    );
    expect(isToolApprovedByGrant(grants, "mcp__krajta__fetch_document")).toBe(
      false,
    );
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

describe("hasApprovalResponseAwaitingModelStep", () => {
  test("recognizes dynamic MCP approval responses", () => {
    expect(
      hasApprovalResponseAwaitingModelStep({
        messages: [
          {
            id: "message-1",
            parts: [
              {
                approval: { approved: true, id: "approval-1" },
                input: { query: "protección de datos" },
                state: "approval-responded",
                toolCallId: "tool-call-1",
                toolName: "mcp__legal-data-hunter__search",
                type: "dynamic-tool",
              } as ChatPart,
            ],
            role: "assistant",
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("hasRunningToolCallInLatestAssistantMessage", () => {
  test("treats in-flight tool input as an active assistant response", () => {
    const messages = [
      {
        id: "message-1",
        parts: [
          {
            input: { query: "consumer credit" },
            state: "input-available",
            toolCallId: "tool-call-1",
            toolName: "mcp__salvia__search_decisions",
            type: "dynamic-tool",
          },
        ],
        role: "assistant",
      },
    ] satisfies Parameters<
      typeof hasRunningToolCallInLatestAssistantMessage
    >[0]["messages"];

    expect(hasRunningToolCallInLatestAssistantMessage({ messages })).toBe(true);
  });

  test("ignores completed tool output", () => {
    const messages = [
      {
        id: "message-1",
        parts: [
          {
            input: { query: "consumer credit" },
            output: { content: [] },
            state: "output-available",
            toolCallId: "tool-call-1",
            toolName: "mcp__salvia__search_decisions",
            type: "dynamic-tool",
          },
        ],
        role: "assistant",
      },
    ] satisfies Parameters<
      typeof hasRunningToolCallInLatestAssistantMessage
    >[0]["messages"];

    expect(hasRunningToolCallInLatestAssistantMessage({ messages })).toBe(
      false,
    );
  });

  test("ignores stale running tool parts from older messages", () => {
    const messages = [
      {
        id: "message-1",
        parts: [
          {
            input: { query: "consumer credit" },
            state: "input-available",
            toolCallId: "tool-call-1",
            toolName: "mcp__salvia__search_decisions",
            type: "dynamic-tool",
          },
        ],
        role: "assistant",
      },
      {
        id: "message-2",
        parts: [{ text: "new prompt", type: "text" }],
        role: "user",
      },
    ] satisfies Parameters<
      typeof hasRunningToolCallInLatestAssistantMessage
    >[0]["messages"];

    expect(hasRunningToolCallInLatestAssistantMessage({ messages })).toBe(
      false,
    );
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
