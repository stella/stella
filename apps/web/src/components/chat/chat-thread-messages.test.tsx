import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import { ChatMattersContext } from "@/components/chat/chat-matters-context";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import messages from "@/i18n/langs/en.json";
import type Messages from "@/i18n/langs/messages.gen";

const previousApiUrl = process.env["VITE_API_URL"];
process.env["VITE_API_URL"] = previousApiUrl ?? "https://api.example.test";

const { ChatThreadMessages } =
  await import("@/components/chat/chat-thread-messages");
const { buildMessageTurns } =
  await import("@/components/chat/chat-thread-messages.logic");

afterAll(() => {
  if (previousApiUrl === undefined) {
    delete process.env["VITE_API_URL"];
    return;
  }
  process.env["VITE_API_URL"] = previousApiUrl;
});

const renderWithProviders = (children: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider
        locale="en"
        // SAFETY: this mirrors the app provider boundary; locale
        // files are checked separately, while use-intl preserves
        // English literal values in the generated Messages type.
        // eslint-disable-next-line typescript/no-unsafe-type-assertion -- mirrors app provider boundary; use-intl Messages keeps English literal values
        messages={messages as Messages}
        timeZone="UTC"
      >
        <ChatMattersContext
          value={{
            createDocumentMatters: [],
            isLoadingCreateDocumentMatters: false,
          }}
        >
          <ChatApprovalContext
            value={{
              activeOrganizationId: "test-active-organization",
              alwaysApprovedTools: new Set(),
              conversationApprovedTools: new Set(),
              handleAllowInConversation: () => {},
              handleAlwaysAllow: () => {},
              handleApprove: () => {},
              handleDeny: () => {},
            }}
          >
            {children}
          </ChatApprovalContext>
        </ChatMattersContext>
      </IntlProvider>
    </QueryClientProvider>,
  );

describe("chat thread messages", () => {
  test("does not flash TipTap paragraph tags for an optimistic user message", () => {
    const chatMessages: PersistedChatMessage[] = [
      {
        id: "message-user",
        parts: [{ type: "text", content: "<p>ahoj</p>" }],
        role: "user",
      },
    ];

    const html = renderWithProviders(
      <ChatThreadMessages
        approvalPendingMessageId={null}
        messages={chatMessages}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("ahoj");
    expect(html).not.toContain("&lt;p&gt;");
    expect(html).not.toContain("&lt;/p&gt;");
  });

  test("treats an error as terminal even if generation state is stale", () => {
    const html = renderWithProviders(
      <ChatThreadMessages
        approvalPendingMessageId={null}
        error={new Error("provider failed")}
        isGenerating
        messages={[]}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        onResend={() => {}}
        showThinkingIndicator
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("There was an issue sending your message.");
    expect(html).not.toContain("Working with context");
    expect(html).not.toContain('disabled=""');
  });

  test("shows a copy action at the end of assistant responses", () => {
    const chatMessages: PersistedChatMessage[] = [
      {
        id: "message-A",
        parts: [{ type: "text", content: "Draft answer" }],
        role: "assistant",
      },
    ];

    const html = renderWithProviders(
      <ChatThreadMessages
        approvalPendingMessageId={null}
        messages={chatMessages}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("Draft answer");
    expect(html).toContain('aria-label="Copy"');
    expect(html).toContain(">Copy</button>");
  });

  test("renders assistant reasoning separately from the final answer", () => {
    const chatMessages: PersistedChatMessage[] = [
      {
        id: "message-A",
        metadata: {
          usage: {
            completionTokens: 20,
            completionTokensDetails: { reasoningTokens: 12 },
            promptTokens: 10,
            totalTokens: 30,
          },
        },
        parts: [
          { type: "thinking", content: "Checked the contract timeline." },
          { type: "text", content: "The deadline is Friday." },
        ],
        role: "assistant",
      },
    ];

    const html = renderWithProviders(
      <ChatThreadMessages
        approvalPendingMessageId={null}
        messages={chatMessages}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain(">Reasoning trace<");
    expect(html).toContain("<details");
    expect(html).not.toContain('open=""');
    expect(html).toContain("12 reasoning tokens");
    expect(html).toContain("Checked the contract timeline.");
    expect(html).toContain("The deadline is Friday.");
    expect(html.match(/>Copy<\/button>/gu)?.length).toBe(1);
  });

  test("shows provider-reported reasoning tokens without a thinking part", () => {
    const chatMessages: PersistedChatMessage[] = [
      {
        id: "message-A",
        metadata: {
          usage: {
            completionTokens: 20,
            completionTokensDetails: { reasoningTokens: 8 },
            promptTokens: 10,
            totalTokens: 30,
          },
        },
        parts: [{ type: "text", content: "The answer is ready." }],
        role: "assistant",
      },
    ];

    const html = renderWithProviders(
      <ChatThreadMessages
        approvalPendingMessageId={null}
        messages={chatMessages}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("8 reasoning tokens");
    expect(html).toContain("The answer is ready.");
  });

  test("renders non-approval tool calls when tool details are enabled", () => {
    const chatMessages: PersistedChatMessage[] = [
      {
        id: "message-A",
        parts: [
          {
            type: "tool-call",
            id: "tool-call-search",
            name: "search-chat-history",
            arguments: JSON.stringify({ query: "deadline" }),
            state: "complete",
            input: { query: "deadline" },
            output: { query: "deadline", results: [] },
          },
        ],
        role: "assistant",
      },
    ];

    const html = renderWithProviders(
      <ChatThreadMessages
        approvalPendingMessageId={null}
        messages={chatMessages}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        showToolCalls
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("Searching chat history");
  });

  test("keeps assistant reasoning visible while it is the only streaming content", () => {
    const chatMessages: PersistedChatMessage[] = [
      {
        id: "message-A",
        parts: [{ type: "thinking", content: "Reading cited documents." }],
        role: "assistant",
      },
    ];

    const html = renderWithProviders(
      <ChatThreadMessages
        approvalPendingMessageId={null}
        isGenerating
        messages={chatMessages}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).not.toContain("<details");
    expect(html).toContain("Reading cited documents.");
    expect(html).not.toContain("Working with context");
  });

  test("keeps assistant reasoning visible if streaming settles before answer text starts", () => {
    const chatMessages: PersistedChatMessage[] = [
      {
        id: "message-A",
        parts: [{ type: "thinking", content: "Checking cited filings." }],
        role: "assistant",
      },
    ];

    const html = renderWithProviders(
      <ChatThreadMessages
        approvalPendingMessageId={null}
        messages={chatMessages}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).not.toContain("<details");
    expect(html).toContain("Checking cited filings.");
    expect(html).not.toContain("Working with context");
  });

  test("uses generated thumbnail URLs for image attachments with placeholders", () => {
    const imagePart = {
      type: "image",
      source: {
        type: "url",
        value: "stella://file::file_test123",
        mimeType: "image/png",
      },
      metadata: {
        filename: "evidence.png",
        placeholder: "data:image/png;base64,AAAA",
      },
    } as const;
    const chatMessages: PersistedChatMessage[] = [
      {
        id: "message-A",
        parts: [imagePart],
        role: "user",
      },
    ];

    const html = renderWithProviders(
      <ChatThreadMessages
        approvalPendingMessageId={null}
        messages={chatMessages}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("/v1/user-files/file_test123/thumbnail");
    expect(html).toContain("background-image");
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain('aria-label="Preview: evidence.png"');
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain('href="/v1/user-files/file_test123/content"');
  });

  test("shows retry only on the latest assistant response", () => {
    const chatMessages: PersistedChatMessage[] = [
      {
        id: "message-A",
        parts: [{ type: "text", content: "First answer" }],
        role: "assistant",
      },
      {
        id: "message-B",
        parts: [{ type: "text", content: "Second answer" }],
        role: "assistant",
      },
    ];

    const html = renderWithProviders(
      <ChatThreadMessages
        approvalPendingMessageId={null}
        messages={chatMessages}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        onResend={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("First answer");
    expect(html).toContain("Second answer");
    expect(html.match(/>Copy<\/button>/gu)?.length).toBe(2);
    expect(html.match(/>Retry<\/button>/gu)?.length).toBe(1);
  });

  test("hides retry when a later user message is the final turn", () => {
    const chatMessages: PersistedChatMessage[] = [
      {
        id: "message-A",
        parts: [{ type: "text", content: "Answer before retry" }],
        role: "assistant",
      },
      {
        id: "message-B",
        parts: [{ type: "text", content: "Follow-up prompt" }],
        role: "user",
      },
    ];

    const html = renderWithProviders(
      <ChatThreadMessages
        approvalPendingMessageId={null}
        messages={chatMessages}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        onResend={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("Answer before retry");
    expect(html).toContain("Follow-up prompt");
    expect(html.match(/>Copy<\/button>/gu)?.length).toBe(1);
    expect(html).not.toContain(">Retry</button>");
  });

  test("hides retry while the latest assistant response is generating", () => {
    const chatMessages: PersistedChatMessage[] = [
      {
        id: "message-A",
        parts: [{ type: "text", content: "Streaming answer" }],
        role: "assistant",
      },
    ];

    const html = renderWithProviders(
      <ChatThreadMessages
        approvalPendingMessageId={null}
        isGenerating
        messages={chatMessages}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        onResend={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("Streaming answer");
    expect(html).toContain(">Copy</button>");
    expect(html).not.toContain(">Retry</button>");
  });

  test("shows a resendable chat message when the chat runtime errors", () => {
    const html = renderWithProviders(
      <ChatThreadMessages
        approvalPendingMessageId={null}
        error={new Error("provider details must stay hidden")}
        messages={[]}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        onResend={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("There was an issue sending your message.");
    expect(html).toContain("Resend");
    expect(html).not.toContain("provider details must stay hidden");
  });

  test("maps model-unavailable stream errors to admin-facing copy", () => {
    const html = renderWithProviders(
      <ChatThreadMessages
        approvalPendingMessageId={null}
        error={new Error("model_unavailable")}
        messages={[]}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        onResend={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("The configured AI model is no longer available");
    expect(html).toContain("Resend");
    expect(html).not.toContain("model_unavailable");
  });

  test("offers a raw-send override when anonymization blocks an attachment", () => {
    const html = renderWithProviders(
      <ChatThreadMessages
        approvalPendingMessageId={null}
        error={
          new Error(
            JSON.stringify({
              code: "third_party_boundary_refusal",
              message:
                "Cannot send this attachment to the AI in anonymized mode because stella cannot extract and anonymize it safely.",
            }),
          )
        }
        messages={[]}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        onResend={() => {}}
        onSendWithoutAnonymization={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("stella could not anonymize one attachment");
    expect(html).toContain("Send without anonymization");
    expect(html).not.toContain("Cannot send this attachment");
  });
});

describe("buildMessageTurns", () => {
  const userMessage = (id: string): PersistedChatMessage => ({
    id,
    parts: [{ type: "text", content: id }],
    role: "user",
  });
  const assistantMessage = (id: string): PersistedChatMessage => ({
    id,
    parts: [{ type: "text", content: id }],
    role: "assistant",
  });

  test("opens a turn per user message and attaches following answers to it", () => {
    const turns = buildMessageTurns([
      userMessage("u1"),
      assistantMessage("a1"),
      assistantMessage("a2"),
      userMessage("u2"),
      assistantMessage("a3"),
    ]);

    expect(turns.map((turn) => turn.type)).toEqual(["user", "user"]);
    const [first, second] = turns;
    if (first?.type !== "user" || second?.type !== "user") {
      throw new Error("expected two user-led turns");
    }
    expect(first.header.id).toBe("u1");
    expect(first.index).toBe(0);
    expect(first.body.map((item) => item.message.id)).toEqual(["a1", "a2"]);
    // Flat indices are preserved so downstream restoration/retry lookups match.
    expect(first.body.map((item) => item.index)).toEqual([1, 2]);
    expect(second.header.id).toBe("u2");
    expect(second.index).toBe(3);
    expect(second.body.map((item) => item.index)).toEqual([4]);
  });

  test("groups assistant messages preceding any user message into an orphan turn", () => {
    const turns = buildMessageTurns([
      assistantMessage("a1"),
      assistantMessage("a2"),
      userMessage("u1"),
    ]);

    expect(turns.map((turn) => turn.type)).toEqual(["orphan", "user"]);
    const [orphan] = turns;
    if (orphan?.type !== "orphan") {
      throw new Error("expected a leading orphan turn");
    }
    expect(orphan.body.map((item) => item.index)).toEqual([0, 1]);
  });
});
