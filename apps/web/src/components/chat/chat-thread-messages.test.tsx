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
        // eslint-disable-next-line typescript/no-unsafe-type-assertion
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
  test("shows a copy action at the end of assistant responses", () => {
    const chatMessages: PersistedChatMessage[] = [
      {
        id: "message-A",
        parts: [{ type: "text", text: "Draft answer" }],
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
        showToolCalls={false}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("Draft answer");
    expect(html).toContain('aria-label="Copy"');
    expect(html).toContain(">Copy</button>");
  });

  test("uses generated thumbnail URLs for image attachments with placeholders", () => {
    const imagePart = {
      type: "file",
      filename: "evidence.png",
      mediaType: "image/png",
      placeholder: "data:image/png;base64,AAAA",
      url: "stella://file::file_test123",
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
        showToolCalls={false}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("/v1/user-files/file_test123/content");
    expect(html).toContain("/v1/user-files/file_test123/thumbnail");
    expect(html).toContain("background-image");
    expect(html).toContain("data:image/png;base64,AAAA");
  });

  test("shows retry only on the latest assistant response", () => {
    const chatMessages: PersistedChatMessage[] = [
      {
        id: "message-A",
        parts: [{ type: "text", text: "First answer" }],
        role: "assistant",
      },
      {
        id: "message-B",
        parts: [{ type: "text", text: "Second answer" }],
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
        showToolCalls={false}
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
        parts: [{ type: "text", text: "Answer before retry" }],
        role: "assistant",
      },
      {
        id: "message-B",
        parts: [{ type: "text", text: "Follow-up prompt" }],
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
        showToolCalls={false}
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
        parts: [{ type: "text", text: "Streaming answer" }],
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
        showToolCalls={false}
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
        showToolCallDetails={false}
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
        showToolCallDetails={false}
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
        showToolCallDetails={false}
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
