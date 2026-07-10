import { describe, expect, test } from "bun:test";

import {
  getChatToolTitleKey,
  getApprovalToolName,
  getToolApprovalGrant,
  getUserMessageHtmlHistory,
  hasApprovalResponseAwaitingModelStep,
  hasApprovedActiveDocxEditAwaitingClientOutput,
  hasRunningToolCallInLatestAssistantMessage,
  isApprovalOnceChatToolName,
  isApprovalPart,
  isChatTurnInFlight,
  isExternalInputChatToolName,
  isPublicOfficialChatToolName,
  isToolApprovedByGrant,
  isUnresolvedFolioAgentDocToolCallPart,
  sanitizeRunningToolCalls,
  selectUnresolvedFolioAgentDocToolCallParts,
  withParsedToolCallInputs,
} from "@/components/chat/chat-ui-tools";
import type {
  ChatPart,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";

describe("chat tool titles", () => {
  test("maps stella API tools to translation keys", () => {
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

  test("maps the folio-agents comment/changes and version-compare tools", () => {
    expect(getChatToolTitleKey("read_changes")).toBe("chat.tool.read_changes");
    expect(getChatToolTitleKey("read_comments")).toBe(
      "chat.tool.read_comments",
    );
    expect(getChatToolTitleKey("add_comment")).toBe("chat.tool.add_comment");
    expect(getChatToolTitleKey("reply_comment")).toBe(
      "chat.tool.reply_comment",
    );
    expect(getChatToolTitleKey("resolve_comment")).toBe(
      "chat.tool.resolve_comment",
    );
    expect(getChatToolTitleKey("compare_versions")).toBe(
      "chat.tool.compare_versions",
    );
  });

  test("uses the translated unknown fallback for unknown tools", () => {
    expect(getChatToolTitleKey("searchCaseLaw")).toBe("chat.tool.unknown");
  });
});

describe("isApprovalPart", () => {
  test("distinguishes official public lookup tools from other public tools", () => {
    expect(isPublicOfficialChatToolName("business_registry_lookup")).toBe(true);
    expect(isPublicOfficialChatToolName("infosoud_lookup_case")).toBe(true);
    expect(isPublicOfficialChatToolName("mcp__salvia__search_decisions")).toBe(
      false,
    );
    // Legacy aliases that pre-date the unified business_registry_lookup
    // tool should NOT count as currently-registered public-official
    // tools — they only render in chat history.
    expect(isPublicOfficialChatToolName("ares_lookup_company")).toBe(false);
    expect(isPublicOfficialChatToolName("ares_search_companies")).toBe(false);
  });

  test("identifies built-in tools whose external request needs a preview", () => {
    expect(isExternalInputChatToolName("web_search")).toBe(true);
    expect(isExternalInputChatToolName("fetch_url")).toBe(true);
    expect(isExternalInputChatToolName("boe_search_legislation")).toBe(true);
    expect(isExternalInputChatToolName("boe_get_law")).toBe(false);
  });

  test("treats active DOCX edit tools as approval parts", () => {
    const part = {
      approval: { id: "approval-1", needsApproval: true },
      arguments: JSON.stringify({ operations: [] }),
      id: "tool-call-1",
      input: { operations: [] },
      state: "approval-requested",
      name: "apply-active-docx-edits",
      type: "tool-call",
    } satisfies ChatPart;

    expect(isApprovalPart(part)).toBe(true);
  });

  test("treats external MCP tools as approval parts", () => {
    const part = {
      approval: { id: "approval-1", needsApproval: true },
      arguments: JSON.stringify({ query: "civil code" }),
      id: "tool-call-1",
      input: { query: "civil code" },
      state: "approval-requested",
      name: "mcp__salvia__search_decisions",
      type: "tool-call",
    } satisfies ChatPart;

    expect(isApprovalPart(part)).toBe(true);
  });

  test("extracts approval tool names from external MCP approval requests", () => {
    const part = {
      approval: { id: "approval-1", needsApproval: true },
      arguments: JSON.stringify({ query: "protección de datos" }),
      id: "tool-call-1",
      input: { query: "protección de datos" },
      state: "approval-requested",
      name: "mcp__legal-data-hunter__search",
      type: "tool-call",
    } satisfies ChatPart;

    expect(isApprovalPart(part)).toBe(true);
    if (!isApprovalPart(part)) {
      throw new Error("Expected MCP approval part");
    }

    expect(getApprovalToolName(part)).toBe("mcp__legal-data-hunter__search");
  });

  test("does not treat legacy dynamic tool parts as approval parts", () => {
    const part = {
      approval: { id: "approval-1" },
      input: { ico: "27082440" },
      providerExecuted: false,
      state: "approval-requested",
      toolCallId: "tool-call-1",
      type: "tool-ares_lookup_company",
    };

    expect(isApprovalPart(part)).toBe(false);
  });

  test("does not treat legacy public ARES output as an approval part", () => {
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
      arguments: JSON.stringify({
        analysis: "Need the user's answer.",
        questions: [],
      }),
      id: "tool-call-1",
      input: { analysis: "Need the user's answer.", questions: [] },
      state: "input-complete",
      name: "ask-user",
      type: "tool-call",
    } satisfies ChatPart;

    expect(isApprovalPart(part)).toBe(false);
  });
});

describe("tool approval grants", () => {
  test("keeps organization management approvals per call", () => {
    expect(isApprovalOnceChatToolName("manage_organization")).toBe(true);
    expect(isApprovalOnceChatToolName("save_clause")).toBe(false);
  });

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
                approval: {
                  approved: true,
                  id: "approval-1",
                  needsApproval: true,
                },
                arguments: JSON.stringify({ operations: [] }),
                id: "tool-call-1",
                input: { operations: [] },
                state: "approval-responded",
                name: "apply-active-docx-edits",
                type: "tool-call",
              } satisfies ChatPart,
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
                approval: {
                  approved: false,
                  id: "approval-1",
                  needsApproval: true,
                },
                arguments: JSON.stringify({ operations: [] }),
                id: "tool-call-1",
                input: { operations: [] },
                state: "approval-responded",
                name: "apply-active-docx-edits",
                type: "tool-call",
              } satisfies ChatPart,
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
                approval: {
                  approved: true,
                  id: "approval-1",
                  needsApproval: true,
                },
                arguments: JSON.stringify({ query: "protección de datos" }),
                id: "tool-call-1",
                input: { query: "protección de datos" },
                state: "approval-responded",
                name: "mcp__legal-data-hunter__search",
                type: "tool-call",
              } satisfies ChatPart,
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
            arguments: JSON.stringify({ query: "consumer credit" }),
            id: "tool-call-1",
            input: { query: "consumer credit" },
            state: "input-complete",
            name: "mcp__salvia__search_decisions",
            type: "tool-call",
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
            arguments: JSON.stringify({ query: "consumer credit" }),
            id: "tool-call-1",
            input: { query: "consumer credit" },
            output: { content: [] },
            state: "complete",
            name: "mcp__salvia__search_decisions",
            type: "tool-call",
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

  test("ignores ask-user prompts waiting for a user answer", () => {
    const messages = [
      {
        id: "message-1",
        parts: [
          {
            arguments: JSON.stringify({
              analysis: "Need the user's answer.",
              questions: [],
            }),
            id: "tool-call-1",
            input: { analysis: "Need the user's answer.", questions: [] },
            state: "input-complete",
            name: "ask-user",
            type: "tool-call",
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

  test("ignores create-document prompts waiting for a matter selection", () => {
    const messages = [
      {
        id: "message-1",
        parts: [
          {
            arguments: JSON.stringify({
              name: "Engagement letter",
              source: "@title Engagement letter",
            }),
            id: "tool-call-1",
            input: {
              name: "Engagement letter",
              source: "@title Engagement letter",
            },
            state: "input-complete",
            name: "create-document",
            type: "tool-call",
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
            arguments: JSON.stringify({ query: "consumer credit" }),
            id: "tool-call-1",
            input: { query: "consumer credit" },
            state: "input-complete",
            name: "mcp__salvia__search_decisions",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        id: "message-2",
        parts: [{ content: "new prompt", type: "text" }],
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

describe("isUnresolvedFolioAgentDocToolCallPart", () => {
  test("matches a completed read_document call awaiting a result", () => {
    const part = {
      arguments: "{}",
      id: "tool-call-1",
      input: {},
      state: "input-complete",
      name: "read_document",
      type: "tool-call",
    };

    expect(isUnresolvedFolioAgentDocToolCallPart(part)).toBe(true);
  });

  test("matches a completed find_text call awaiting a result", () => {
    const part = {
      arguments: JSON.stringify({ query: "termination" }),
      id: "tool-call-2",
      input: { query: "termination" },
      state: "input-complete",
      name: "find_text",
      type: "tool-call",
    };

    expect(isUnresolvedFolioAgentDocToolCallPart(part)).toBe(true);
  });

  test("matches completed read_changes and read_comments calls (auto-run)", () => {
    for (const name of ["read_changes", "read_comments"]) {
      const part = {
        arguments: "{}",
        id: `tool-call-${name}`,
        input: {},
        state: "input-complete",
        name,
        type: "tool-call",
      };
      expect(isUnresolvedFolioAgentDocToolCallPart(part)).toBe(true);
    }
  });

  test("ignores the comment-mutation tools (approval-gated, not auto-run)", () => {
    for (const name of ["add_comment", "reply_comment", "resolve_comment"]) {
      const part = {
        arguments: "{}",
        id: `tool-call-${name}`,
        input: {},
        state: "input-complete",
        name,
        type: "tool-call",
      };
      expect(isUnresolvedFolioAgentDocToolCallPart(part)).toBe(false);
    }
  });

  test("ignores a read_document call still streaming its input", () => {
    const part = {
      arguments: "{",
      id: "tool-call-1",
      state: "input-streaming",
      name: "read_document",
      type: "tool-call",
    };

    expect(isUnresolvedFolioAgentDocToolCallPart(part)).toBe(false);
  });

  test("ignores an already-resolved read_document call", () => {
    const part = {
      arguments: "{}",
      id: "tool-call-1",
      input: {},
      output: { ok: true, result: [] },
      state: "complete",
      name: "read_document",
      type: "tool-call",
    };

    expect(isUnresolvedFolioAgentDocToolCallPart(part)).toBe(false);
  });

  test("ignores unrelated tool calls", () => {
    const part = {
      arguments: JSON.stringify({ query: "consumer credit" }),
      id: "tool-call-1",
      input: { query: "consumer credit" },
      state: "input-complete",
      name: "mcp__salvia__search_decisions",
      type: "tool-call",
    };

    expect(isUnresolvedFolioAgentDocToolCallPart(part)).toBe(false);
  });

  test("ignores non-tool-call parts", () => {
    expect(
      isUnresolvedFolioAgentDocToolCallPart({
        content: "hello",
        type: "text",
      }),
    ).toBe(false);
    expect(isUnresolvedFolioAgentDocToolCallPart(null)).toBe(false);
    expect(isUnresolvedFolioAgentDocToolCallPart("read_document")).toBe(false);
  });
});

describe("selectUnresolvedFolioAgentDocToolCallParts", () => {
  // Core decision loop behind the file overlay's folio-agents doc-tool
  // auto-run watcher (`file-chat-overlay.tsx`): given the latest
  // assistant message's parts and the ids the watcher already dispatched
  // itself, which parts still need a client-executed result.
  const readDocumentPart = {
    arguments: "{}",
    id: "tool-call-read",
    input: {},
    state: "input-complete",
    name: "read_document",
    type: "tool-call",
  } satisfies ChatPart;

  const findTextPart = {
    arguments: JSON.stringify({ query: "termination" }),
    id: "tool-call-find",
    input: { query: "termination" },
    state: "input-complete",
    name: "find_text",
    type: "tool-call",
  } satisfies ChatPart;

  test("selects input-complete folio tool parts once", () => {
    const result = selectUnresolvedFolioAgentDocToolCallParts(
      [readDocumentPart, findTextPart],
      new Set(),
    );

    expect(result.map((part) => part.id)).toEqual([
      "tool-call-read",
      "tool-call-find",
    ]);
  });

  test("skips ids already recorded as executed", () => {
    const result = selectUnresolvedFolioAgentDocToolCallParts(
      [readDocumentPart, findTextPart],
      new Set(["tool-call-read"]),
    );

    expect(result.map((part) => part.id)).toEqual(["tool-call-find"]);
  });

  test("skips other tools and non-input-complete states", () => {
    const askUserPart = {
      arguments: JSON.stringify({ analysis: "", questions: [] }),
      id: "tool-call-ask",
      input: { analysis: "", questions: [] },
      state: "input-complete",
      name: "ask-user",
      type: "tool-call",
    } satisfies ChatPart;
    const streamingReadDocumentPart = {
      arguments: "{",
      id: "tool-call-streaming",
      state: "input-streaming",
      name: "read_document",
      type: "tool-call",
    } satisfies ChatPart;
    const resolvedFindTextPart = {
      arguments: JSON.stringify({ query: "termination" }),
      id: "tool-call-resolved",
      input: { query: "termination" },
      output: { ok: true, matches: [] },
      state: "complete",
      name: "find_text",
      type: "tool-call",
    } satisfies ChatPart;

    const result = selectUnresolvedFolioAgentDocToolCallParts(
      [askUserPart, streamingReadDocumentPart, resolvedFindTextPart],
      new Set(),
    );

    expect(result).toEqual([]);
  });

  // The Template Studio hang this watcher guards against never reaches
  // this pure selector at all: `read_document` / `find_text` tool-call
  // parts only ever appear in a message when the server registered the
  // tools (gated by `hasActiveDocxFileClient`, file-overlay-only). That
  // registration gate is server-side and is covered by
  // `tool-schema.test.ts`'s "registers the folio-agents read_document/
  // find_text tools only when the file-overlay docx client is active" —
  // there is no meaningful client-only regression to exercise here.
});

describe("isChatTurnInFlight", () => {
  const messagesWithRunningToolCall = [
    {
      id: "message-1",
      parts: [
        {
          arguments: JSON.stringify({ query: "consumer credit" }),
          id: "tool-call-1",
          input: { query: "consumer credit" },
          name: "mcp__salvia__search_decisions",
          state: "input-streaming",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
  ] satisfies Parameters<typeof isChatTurnInFlight>[0]["messages"];

  test("treats an active request as in flight regardless of the message tail", () => {
    expect(isChatTurnInFlight({ status: "submitted", messages: [] })).toBe(
      true,
    );
    expect(isChatTurnInFlight({ status: "streaming", messages: [] })).toBe(
      true,
    );
  });

  test("keeps a ready chat with a running tool call in flight (between-steps window)", () => {
    expect(
      isChatTurnInFlight({
        status: "ready",
        messages: messagesWithRunningToolCall,
      }),
    ).toBe(true);
  });

  test("never treats an errored turn as in flight, even with a stuck running tool part", () => {
    // A stream that dies mid tool call leaves the part in a running
    // state while the SDK flips to "error" and never continues the
    // turn; counting that tail as in-flight wedges the session.
    expect(
      isChatTurnInFlight({
        status: "error",
        messages: messagesWithRunningToolCall,
      }),
    ).toBe(false);
  });

  test("does not treat an abandoned turn as in flight despite a stuck running tool part", () => {
    expect(
      isChatTurnInFlight({
        status: "ready",
        messages: messagesWithRunningToolCall,
        turnAbandoned: true,
      }),
    ).toBe(false);
  });

  test("is idle without an active request or running tool call", () => {
    expect(isChatTurnInFlight({ status: "ready", messages: [] })).toBe(false);
  });
});

describe("sanitizeRunningToolCalls", () => {
  const runningToolPart = {
    arguments: JSON.stringify({ query: "consumer credit" }),
    id: "tool-call-1",
    input: { query: "consumer credit" },
    name: "mcp__salvia__search_decisions",
    state: "input-complete",
    type: "tool-call",
  } satisfies ChatPart;

  test("rewrites a dead running tool call in the last assistant message to the terminal error state", () => {
    const messages: PersistedChatMessage[] = [
      { id: "message-1", parts: [runningToolPart], role: "assistant" },
    ];

    const sanitized = sanitizeRunningToolCalls(messages);
    const part = sanitized[0]?.parts[0];
    if (part?.type !== "tool-call") {
      throw new Error("Expected a tool-call part");
    }

    expect(part.state).toBe("error");
    // The wedge driver now reads the freshly loaded thread as idle.
    expect(
      hasRunningToolCallInLatestAssistantMessage({ messages: sanitized }),
    ).toBe(false);
  });

  test("also sanitizes a dead running tool call in an earlier assistant message", () => {
    const messages: PersistedChatMessage[] = [
      { id: "message-1", parts: [runningToolPart], role: "assistant" },
      {
        id: "message-2",
        parts: [{ content: "follow-up prompt", type: "text" }],
        role: "user",
      },
    ];

    const sanitized = sanitizeRunningToolCalls(messages);
    const part = sanitized[0]?.parts[0];
    if (part?.type !== "tool-call") {
      throw new Error("Expected a tool-call part");
    }

    expect(part.state).toBe("error");
    // The trailing user message is untouched (reference preserved).
    expect(sanitized[1]).toBe(messages[1]);
  });

  test("leaves ask-user prompts awaiting a user answer untouched", () => {
    const messages: PersistedChatMessage[] = [
      {
        id: "message-1",
        parts: [
          {
            arguments: JSON.stringify({ analysis: "", questions: [] }),
            id: "tool-call-1",
            input: { analysis: "", questions: [] },
            name: "ask-user",
            state: "input-complete",
            type: "tool-call",
          } satisfies ChatPart,
        ],
        role: "assistant",
      },
    ];

    // Long-lived by design: the message keeps its reference (no change).
    expect(sanitizeRunningToolCalls(messages)[0]).toBe(messages[0]);
  });

  test("leaves an approval-requested tool call untouched", () => {
    const messages: PersistedChatMessage[] = [
      {
        id: "message-1",
        parts: [
          {
            approval: { id: "approval-1", needsApproval: true },
            arguments: JSON.stringify({ query: "civil code" }),
            id: "tool-call-1",
            input: { query: "civil code" },
            name: "mcp__salvia__search_decisions",
            state: "approval-requested",
            type: "tool-call",
          } satisfies ChatPart,
        ],
        role: "assistant",
      },
    ];

    expect(sanitizeRunningToolCalls(messages)[0]).toBe(messages[0]);
  });

  test("leaves a completed tool call untouched", () => {
    const messages: PersistedChatMessage[] = [
      {
        id: "message-1",
        parts: [
          {
            arguments: JSON.stringify({ query: "consumer credit" }),
            id: "tool-call-1",
            input: { query: "consumer credit" },
            output: { content: [] },
            name: "mcp__salvia__search_decisions",
            state: "complete",
            type: "tool-call",
          } satisfies ChatPart,
        ],
        role: "assistant",
      },
    ];

    expect(sanitizeRunningToolCalls(messages)[0]).toBe(messages[0]);
  });

  test("is a no-op for an empty thread or a user-last transcript", () => {
    expect(sanitizeRunningToolCalls([])).toEqual([]);

    const messages: PersistedChatMessage[] = [
      {
        id: "message-1",
        parts: [{ content: "Assistant reply", type: "text" }],
        role: "assistant",
      },
      {
        id: "message-2",
        parts: [{ content: "Latest prompt", type: "text" }],
        role: "user",
      },
    ];

    const sanitized = sanitizeRunningToolCalls(messages);
    // Nothing running anywhere: every message keeps its reference.
    expect(sanitized[0]).toBe(messages[0]);
    expect(sanitized[1]).toBe(messages[1]);
  });
});

describe("withParsedToolCallInputs", () => {
  const askUserArguments = JSON.stringify({
    analysis: "Which company did you mean?",
    questions: [
      {
        default: "Alza.cz a.s.",
        question: "Which entity should I look up?",
        reason: "The lookup needs the exact legal entity.",
        options: ["Alza.cz a.s.", "Alzashop.com"],
      },
    ],
  });

  const argumentsOnlyMessages = (part: ChatPart): PersistedChatMessage[] => [
    { id: "message-1", parts: [part], role: "assistant" },
  ];

  test("derives input from arguments on an input-complete tool call", () => {
    // Exactly the persisted/streamed shape TanStack produces: a valid
    // `arguments` JSON string with no `input` field.
    const part = {
      arguments: askUserArguments,
      id: "tool-call-1",
      name: "ask-user",
      state: "input-complete",
      type: "tool-call",
    } satisfies ChatPart;

    const [message] = withParsedToolCallInputs(argumentsOnlyMessages(part));
    const normalized = message?.parts[0];
    if (normalized?.type !== "tool-call" || normalized.name !== "ask-user") {
      throw new Error("Expected a normalized ask-user tool-call part");
    }

    expect(normalized.input).toEqual({
      analysis: "Which company did you mean?",
      questions: [
        {
          default: "Alza.cz a.s.",
          question: "Which entity should I look up?",
          reason: "The lookup needs the exact legal entity.",
          options: ["Alza.cz a.s.", "Alzashop.com"],
        },
      ],
    });
  });

  test("leaves input undefined for invalid JSON arguments without throwing", () => {
    const part = {
      arguments: '{"questions":[',
      id: "tool-call-1",
      name: "ask-user",
      state: "input-complete",
      type: "tool-call",
    } satisfies ChatPart;

    const [message] = withParsedToolCallInputs(argumentsOnlyMessages(part));
    const normalized = message?.parts[0];
    if (normalized?.type !== "tool-call") {
      throw new Error("Expected a tool-call part");
    }

    expect(normalized.input).toBeUndefined();
    // The part is unchanged, so its reference is preserved.
    expect(normalized).toBe(part);
  });

  test("does not parse arguments while the tool call is still streaming", () => {
    const part = {
      arguments: '{"questions":[{"quest',
      id: "tool-call-1",
      name: "ask-user",
      state: "input-streaming",
      type: "tool-call",
    } satisfies ChatPart;

    const [message] = withParsedToolCallInputs(argumentsOnlyMessages(part));
    const normalized = message?.parts[0];
    if (normalized?.type !== "tool-call") {
      throw new Error("Expected a tool-call part");
    }

    expect(normalized.input).toBeUndefined();
    expect(normalized).toBe(part);
  });

  test("preserves an already-populated input and message identity", () => {
    const part = {
      arguments: JSON.stringify({ query: "consumer credit" }),
      id: "tool-call-1",
      input: { query: "consumer credit" },
      name: "mcp__salvia__search_decisions",
      state: "input-complete",
      type: "tool-call",
    } satisfies ChatPart;
    const messages = argumentsOnlyMessages(part);

    const result = withParsedToolCallInputs(messages);

    // Nothing to fill: the message object keeps its reference so
    // downstream memoization is not invalidated.
    expect(result[0]).toBe(messages[0]);
  });
});

describe("getUserMessageHtmlHistory", () => {
  test("returns user message HTML from newest to oldest", () => {
    expect(
      getUserMessageHtmlHistory([
        {
          id: "message-1",
          parts: [{ content: "Older prompt", type: "text" }],
          role: "user",
        },
        {
          id: "message-2",
          parts: [{ content: "Assistant response", type: "text" }],
          role: "assistant",
        },
        {
          id: "message-3",
          parts: [{ content: "Latest prompt", type: "text" }],
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
          parts: [{ content: "Reusable prompt", type: "text" }],
          role: "user",
        },
        {
          id: "message-2",
          parts: [
            {
              metadata: { filename: "contract.pdf" },
              source: {
                mimeType: "application/pdf",
                type: "url",
                value: "https://example.com/contract.pdf",
              },
              type: "document",
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
          parts: [{ content: "   ", type: "text" }],
          role: "user",
        },
        {
          id: "message-2",
          parts: [{ content: "\n<p>Clean prompt</p>\n", type: "text" }],
          role: "user",
        },
      ]),
    ).toEqual(["<p>Clean prompt</p>"]);
  });
});
