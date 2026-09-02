import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import { ChatMattersContext } from "@/components/chat/chat-matters-context";
import type {
  ChatUIMessage,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import messages from "@/i18n/langs/en.json";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { ChatThreadTestRouter } from "@/lib/chat-thread-test-router";

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
    <ChatThreadTestRouter>
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
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
      </QueryClientProvider>
    </ChatThreadTestRouter>,
  );

describe("chat thread messages", () => {
  test("does not flash TipTap paragraph tags for an optimistic user message", () => {
    const chatMessages: ChatUIMessage[] = [
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
    const chatMessages: ChatUIMessage[] = [
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

  test("renders persisted audio, video, and sandboxed app output", () => {
    const chatMessages: ChatUIMessage[] = [
      {
        id: "message-rich",
        role: "assistant",
        parts: [
          {
            type: "audio",
            source: {
              type: "url",
              value: "https://example.test/audio.mp3",
              mimeType: "audio/mpeg",
            },
          },
          {
            type: "video",
            source: {
              type: "url",
              value: "https://example.test/video.mp4",
              mimeType: "video/mp4",
            },
          },
          {
            type: "ui-resource",
            resource: {
              uri: "ui://widget",
              mimeType: "text/html;profile=mcp-app",
              text: "<p>Widget</p>",
            },
            toolCallId: "call-1",
            toolName: "widget",
          },
        ],
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

    expect(html).toContain('aria-label="Generated audio"');
    expect(html).toContain('preload="none"');
    expect(html).not.toContain('preload="metadata"');
    expect(html).toContain('src="https://example.test/audio.mp3"');
    expect(html).toContain('aria-label="Generated video"');
    expect(html).toContain('src="https://example.test/video.mp4"');
    expect(html).toContain("Loading interactive content…");
    expect(html).not.toContain("&lt;p&gt;Widget&lt;/p&gt;");
  });

  test("keeps historical exports available while the latest answer streams", () => {
    const chatMessages: ChatUIMessage[] = [
      {
        id: "message-old",
        parts: [{ type: "text", content: "Completed answer" }],
        role: "assistant",
      },
      {
        id: "message-latest",
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
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
        threadRef={{
          scope: "global",
          threadId: toChatThreadId("thread"),
        }}
      />,
    );

    expect(html.match(/aria-label="Save message"/gu)).toHaveLength(1);
  });

  test("renders assistant reasoning separately from the final answer", () => {
    const chatMessages: ChatUIMessage[] = [
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
    const chatMessages: ChatUIMessage[] = [
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
    const chatMessages: ChatUIMessage[] = [
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

  test("folds process steps across invisible tool results into one disclosure", () => {
    const chatMessages: ChatUIMessage[] = [
      {
        id: "message-A",
        parts: [
          { type: "thinking", content: "Considering the request." },
          {
            type: "tool-call",
            id: "tool-call-failed",
            // An external tool name keeps the output untyped, so the fixture
            // can carry the runtime error shape the renderer inspects.
            name: "mcp__external-lookup",
            arguments: JSON.stringify({ query: "deadline" }),
            state: "error",
            input: { query: "deadline" },
            output: {
              error: { name: "runtime", message: "value is not iterable" },
            },
          },
          {
            type: "tool-result",
            toolCallId: "tool-call-failed",
            content: "value is not iterable",
            state: "error",
            error: "value is not iterable",
          },
          {
            type: "tool-call",
            id: "tool-call-complete",
            name: "mcp__external-lookup",
            arguments: JSON.stringify({ query: "governing law" }),
            state: "complete",
            input: { query: "governing law" },
            output: { result: "Delaware" },
          },
          {
            type: "tool-result",
            toolCallId: "tool-call-complete",
            content: "Delaware",
            state: "complete",
          },
          { type: "text", content: "Here is the answer." },
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

    // The whole run sits behind one step-count summary, collapsed by
    // default; a failed step reads as a short human line with the raw
    // output tucked behind its own disclosure.
    expect(html).toContain("3 steps");
    expect(html).not.toContain(">1 step<");
    expect(html).not.toContain("<details open");
    expect(html).toContain("This step failed — stella will work around it.");
    expect(html).toContain(">Show details<");
    expect(html).toContain("Here is the answer.");
  });

  test("keeps streaming reasoning visible and immediately collapsible", () => {
    const chatMessages: ChatUIMessage[] = [
      {
        id: "message-A",
        parts: [
          {
            type: "thinking",
            content: "## **Reading cited documents** with `create-document`.",
          },
        ],
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

    expect(html).toContain("<details");
    expect(html).toContain('open=""');
    expect(html).toContain("Reading cited documents with create-document.");
    expect(html).not.toContain("**");
    expect(html).not.toContain("animate-pulse");
    expect(html).not.toContain("Working with context");
  });

  test("folds assistant reasoning once streaming settles, even before answer text starts", () => {
    const chatMessages: ChatUIMessage[] = [
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

    // A settled message that never produced answer text now collapses into a
    // foldable <details> (collapsed by default) rather than staying pinned
    // open — the reasoning text is still present, just tucked away.
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("Checking cited filings.");
    expect(html).not.toContain("Working with context");
  });

  test("preserves generated document filename casing in the preview", () => {
    const input = {
      name: "Dohoda_o_ochrane_duvernych_informaci_NDA",
      source:
        "@doc kind=agreement locale=cs page=A4\n@title Dohoda\n**Smluvní strany:** Poskytovatel a příjemce",
    };
    const chatMessages: ChatUIMessage[] = [
      {
        id: "message-document",
        parts: [
          {
            type: "tool-call",
            id: "tool-document",
            name: "create-document",
            arguments: JSON.stringify(input),
            state: "input-complete",
            input,
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
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("Dohoda_o_ochrane_duvernych_informaci_NDA.docx");
    expect(html).toContain("Smluvní strany: Poskytovatel a příjemce");
    expect(html).not.toContain("**Smluvní strany:**");
    expect(html).not.toContain("tracking-wide uppercase");
  });

  test("renders a terminal generated-document state as a failure", () => {
    const chatMessages: ChatUIMessage[] = [
      {
        id: "message-document-error",
        parts: [
          {
            type: "tool-call",
            id: "tool-document-error",
            name: "create-document",
            arguments: "{}",
            state: "error",
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
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("Could not create document");
    expect(html).not.toContain("Document ready");
  });

  test("offers an explicit way to reopen a closed generated draft", () => {
    const input = {
      name: "Power of attorney",
      source: "@doc kind=other locale=en page=A4\n@title Power of attorney",
    };
    const chatMessages: ChatUIMessage[] = [
      {
        id: "message-document-ready",
        parts: [
          {
            type: "tool-call",
            id: "tool-document-ready",
            name: "create-document",
            arguments: JSON.stringify(input),
            input,
            output: {
              success: true,
              destination: "draft",
              fileName: "Power of attorney.docx",
            },
            state: "complete",
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
        onOpenCreateDocumentDraft={() => {}}
        onOpenCreatedDocument={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("Open in editor");
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
    const chatMessages: ChatUIMessage[] = [
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
    const chatMessages: ChatUIMessage[] = [
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
    const chatMessages: ChatUIMessage[] = [
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
    const chatMessages: ChatUIMessage[] = [
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

  test("offers the fork action on every answer, not just the latest", () => {
    const chatMessages: ChatUIMessage[] = [
      {
        id: "message-user",
        parts: [{ type: "text", content: "First ask" }],
        role: "user",
      },
      {
        id: "message-old",
        parts: [{ type: "text", content: "Older answer" }],
        role: "assistant",
      },
      {
        id: "message-latest",
        parts: [{ type: "text", content: "Latest answer" }],
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
        threadRef={{
          scope: "global",
          threadId: toChatThreadId("thread"),
        }}
      />,
    );

    // Both assistant messages: forking neither replaces nor discards
    // anything, so it is not gated on being the latest turn the way retry is.
    // The user message carries no fork action.
    expect(html.match(/>Fork from here<\/button>/gu)).toHaveLength(2);
    expect(html.match(/>Retry<\/button>/gu)).toHaveLength(1);
  });

  test("keeps the fork action off the sticky user header", () => {
    const html = renderWithProviders(
      <ChatThreadMessages
        approvalPendingMessageId={null}
        messages={[
          {
            id: "message-user",
            parts: [{ type: "text", content: "Sticky ask" }],
            role: "user",
          },
          {
            id: "message-assistant",
            parts: [{ type: "text", content: "Sticky answer" }],
            role: "assistant",
          },
        ]}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        stickyUserMessages
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
        threadRef={{
          scope: "global",
          threadId: toChatThreadId("thread"),
        }}
      />,
    );

    // The pinned ask is a user message: only the answer beneath it forks.
    expect(html.match(/>Fork from here<\/button>/gu)).toHaveLength(1);
  });

  test("offers no fork action on a user message", () => {
    const html = renderWithProviders(
      <ChatThreadMessages
        approvalPendingMessageId={null}
        messages={[
          {
            id: "message-replied-ask",
            parts: [{ type: "text", content: "Replied ask" }],
            role: "user",
          },
          {
            id: "message-answer",
            parts: [{ type: "text", content: "The answer" }],
            role: "assistant",
          },
          {
            id: "message-unreplied-ask",
            parts: [{ type: "text", content: "Unreplied ask" }],
            role: "user",
          },
        ]}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
        threadRef={{
          scope: "global",
          threadId: toChatThreadId("thread"),
        }}
      />,
    );

    // Only the answer offers forking. Neither ask does: a fork branches off
    // an answer, and the server rejects any other boundary. An unreplied ask
    // may not even be durable yet, so it could not be one regardless.
    expect(html.match(/>Fork from here<\/button>/gu)).toHaveLength(1);
  });

  test("omits the fork action on surfaces that carry no thread reference", () => {
    const html = renderWithProviders(
      <ChatThreadMessages
        approvalPendingMessageId={null}
        messages={[
          {
            id: "message-user",
            parts: [{ type: "text", content: "Embedded ask" }],
            role: "user",
          },
          {
            id: "message-assistant",
            parts: [{ type: "text", content: "Embedded answer" }],
            role: "assistant",
          },
        ]}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("Embedded answer");
    expect(html).not.toContain("Fork from here");
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
