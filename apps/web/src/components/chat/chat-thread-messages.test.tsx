import type { ReactNode } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Result } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { IntlProvider } from "use-intl";

import {
  AI_ERROR_KINDS,
  AI_FAILURE_CODES,
  CHAT_CONTINUATION_REJECTED_ERROR_CODE,
} from "@stll/api-contract";
import {
  ACTION_ADMISSION_CODES,
  ACTION_ADMISSION_REFUSALS,
} from "@stll/api-contract/action-admission";
import { createChatPastedTextPart } from "@stll/api-contract/chat";
import {
  PROVIDER_SETUP_ERROR_CATALOGUE,
  PROVIDER_SETUP_ERROR_CODE,
} from "@stll/api-contract/provider-setup";

import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";
import { ChatMattersContext } from "@/components/chat/chat-matters-context";
import { getChatAssistantTurnError } from "@/components/chat/chat-ui-tools";
import type {
  ChatUIMessage,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { ChatThreadTestRouter } from "@/lib/chat-thread-test-router";
import { APIError, toAPIError } from "@/lib/errors/api";
import {
  ACTION_ADMISSION_ERROR_KEYS,
  translateError,
} from "@/lib/errors/localization";
import { ProviderDiagnosticError } from "@/lib/errors/provider-diagnostic";

const previousApiUrl = process.env["VITE_API_URL"];
process.env["VITE_API_URL"] = previousApiUrl ?? "https://api.example.test";

const { ChatEditorProvider } =
  await import("@/components/chat-editor-provider");
const { ChatThreadMessages, ChatErrorMessage } =
  await import("@/components/chat/chat-thread-messages");
const { buildMessageTurns, CHAT_MESSAGE_RENDER_POLICY } =
  await import("@/components/chat/chat-thread-messages.logic");

afterAll(() => {
  if (previousApiUrl === undefined) {
    delete process.env["VITE_API_URL"];
    return;
  }
  process.env["VITE_API_URL"] = previousApiUrl;
});

const withProviders = (children: ReactNode, savedSecretAvailable = false) => {
  const queryClient = new QueryClient();
  if (savedSecretAvailable) {
    queryClient.setQueryData(["chat-saved-secret", "test-thread", "sample"], {
      available: true,
      connector: {
        connectionId: "sample-connection",
        displayName: "Sample connector",
        host: "sample.test",
        responseDisposition: "receipt-only",
      },
    });
  }
  return (
    <ChatThreadTestRouter>
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ChatMattersContext
            value={{
              createDocumentMattersView: { type: "empty" },
            }}
          >
            <ChatApprovalContext value={testChatApprovalContextValue}>
              <FormattingProvider locale="en" timeZone="UTC">
                <ChatEditorProvider>{children}</ChatEditorProvider>
              </FormattingProvider>
            </ChatApprovalContext>
          </ChatMattersContext>
        </IntlProvider>
      </QueryClientProvider>
    </ChatThreadTestRouter>
  );
};

const renderWithProviders = (
  children: ReactNode,
  savedSecretAvailable = false,
) => renderToStaticMarkup(withProviders(children, savedSecretAvailable));

const renderWithLoadedMarkdown = async (children: ReactNode) => {
  const stream = await renderToReadableStream(withProviders(children));
  await stream.allReady;
  return new Response(stream).text();
};

const renderedText = (html: string) => {
  const window = new Window();
  const root = window.document.createElement("div");
  // safe-html: React renderToStaticMarkup/renderToReadableStream output from this test's own components, parsed in a detached happy-dom document.
  root.innerHTML = html;
  return root.textContent;
};

/**
 * Whether the disclosure whose trigger reads `label` is open: its trigger's
 * `aria-expanded`, or null when no trigger carries that label. The innermost
 * matching trigger wins, so a step list around a reasoning trace does not
 * answer for it.
 */
const disclosureExpanded = (html: string, label: string): string | null => {
  const window = new Window();
  const root = window.document.createElement("div");
  // safe-html: React renderToStaticMarkup/renderToReadableStream output from this test's own components, parsed in a detached happy-dom document.
  root.innerHTML = html;
  const triggers = [
    ...root.querySelectorAll('[data-slot="collapsible-trigger"]'),
  ].filter((trigger) => trigger.textContent?.includes(label) === true);
  return triggers.at(-1)?.getAttribute("aria-expanded") ?? null;
};

describe("chat thread messages", () => {
  test("activity roles and embedded parts show translated labels without internal payloads", () => {
    for (const role of Object.values(CHAT_MESSAGE_RENDER_POLICY)) {
      if (role === "text") {
        continue;
      }
      for (const stickyUserMessages of [false, true]) {
        const content = {
          status: "Review complete",
          detail: "<script>activity payload</script>",
        };
        const activity = {
          id: "activity-progress",
          role,
          parts: [{ type: "activity", activityType: "review", content }],
        } satisfies ChatUIMessage;
        const html = renderWithProviders(
          <ChatThreadMessages
            activitySession={{
              reportedUnknownActivityTypes: new Set<string>(),
            }}
            approvalPendingMessageId={null}
            messages={[activity]}
            onAskUserSubmit={() => {}}
            onCreateDocumentResolve={() => {}}
            onOpenCreatedDocument={() => {}}
            stickyUserMessages={stickyUserMessages}
            streamdownComponents={{
              a: ({ children, ...props }) => <a {...props}>{children}</a>,
            }}
          />,
        );
        expect(renderedText(html)).toContain(messages.chat.activity.review);
        expect(
          renderedText(html),
          JSON.stringify({ oracle: "chat.render.cards-match-stored" }),
        ).not.toContain(content.status);
        expect(renderedText(html)).not.toContain(content.detail);
        expect(html).toContain("<figcaption");
        expect(html).not.toContain("<script>activity payload</script>");
      }
    }
  });

  test("unknown activity types and malformed activity messages leave the thread readable", () => {
    const activities = [
      {
        id: "activity-unknown",
        role: "activity",
        parts: [
          {
            type: "activity",
            activityType: "internal-event",
            content: { secret: "internal-payload" },
          },
        ],
      },
      { id: "activity-empty", role: "activity", parts: [] },
      {
        id: "activity-text",
        role: "activity",
        parts: [{ type: "text", content: "malformed-activity" }],
      },
      {
        id: "activity-multiple",
        role: "activity",
        parts: [
          { type: "activity", activityType: "review", content: {} },
          { type: "activity", activityType: "progress", content: {} },
        ],
      },
    ] satisfies ChatUIMessage[];
    const rendered = Result.try(() =>
      renderWithProviders(
        <ChatThreadMessages
          activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
          approvalPendingMessageId={null}
          messages={[
            ...activities,
            {
              id: "readable-user",
              role: "user",
              parts: [{ type: "text", content: "Still readable" }],
            },
            {
              id: "activity-progress",
              role: "assistant",
              parts: [
                {
                  type: "activity",
                  activityType: "progress",
                  content: { secret: "internal-payload" },
                },
              ],
            },
          ]}
          onAskUserSubmit={() => {}}
          onCreateDocumentResolve={() => {}}
          onOpenCreatedDocument={() => {}}
          streamdownComponents={{
            a: ({ children, ...props }) => <a {...props}>{children}</a>,
          }}
        />,
      ),
    );
    expect(
      rendered.isOk(),
      JSON.stringify({ oracle: "chat.client.no-errors" }),
    ).toBe(true);
    if (!rendered.isOk()) {
      return;
    }
    const html = rendered.value;
    expect(renderedText(html)).toContain("Still readable");
    expect(renderedText(html)).toContain(messages.chat.thinking);
    expect(renderedText(html)).not.toContain("internal-event");
    expect(renderedText(html)).not.toContain("internal-payload");
    expect(renderedText(html)).not.toContain("malformed-activity");
    expect(
      html.match(/<figcaption/gu),
      JSON.stringify({ oracle: "chat.render.cards-match-stored" }),
    ).toHaveLength(1);
  });

  test("labels a reloaded user stop without labelling other terminal outcomes", () => {
    for (const outcome of [
      { type: "cancelled", reason: "user-stop" },
      { type: "cancelled", reason: "superseded" },
      { type: "completed" },
    ] as const) {
      const stored = {
        id: "assistant-terminal",
        role: "assistant",
        parts: [{ type: "text", content: "A partial answer" }],
        metadata: { turnOutcome: outcome },
      } satisfies ChatUIMessage;
      const html = renderWithProviders(
        <ChatThreadMessages
          activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
          approvalPendingMessageId={null}
          messages={[structuredClone(stored)]}
          onAskUserSubmit={() => {}}
          onCreateDocumentResolve={() => {}}
          onOpenCreatedDocument={() => {}}
          onResend={() => {}}
          streamdownComponents={{
            a: ({ children, ...props }) => <a {...props}>{children}</a>,
          }}
        />,
      );
      expect(renderedText(html).includes(messages.chat.stopped)).toBe(
        outcome.type === "cancelled" && outcome.reason === "user-stop",
      );
    }
  });

  test("renders every reloaded admission refusal with its recovery action", () => {
    for (const code of Object.values(ACTION_ADMISSION_CODES)) {
      const refusal = {
        code,
        ...ACTION_ADMISSION_REFUSALS[code],
        contactUrl: "https://example.test/contact",
      };
      const stored = {
        id: "assistant-refused",
        role: "assistant",
        parts: [],
        metadata: {
          turnOutcome: { type: "failed", error: "unknown", refusal },
        },
      } satisfies PersistedChatMessage;
      const reloaded = structuredClone(stored);
      const html = renderWithProviders(
        <ChatThreadMessages
          activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
          approvalPendingMessageId={null}
          messages={[reloaded]}
          error={getChatAssistantTurnError(reloaded)}
          onAskUserSubmit={() => {}}
          onCreateDocumentResolve={() => {}}
          onOpenCreatedDocument={() => {}}
          onResend={() => {}}
          streamdownComponents={{
            a: ({ children, ...props }) => <a {...props}>{children}</a>,
          }}
        />,
      );
      expect(html).toContain('role="status"');
      expect(renderedText(html)).toContain(
        translateError(ACTION_ADMISSION_ERROR_KEYS[code]),
      );
      expect(html.includes(messages.common.tryAgain)).toBe(refusal.retryable);
      expect(html.includes('href="https://example.test/contact"')).toBe(
        refusal.status === 403,
      );
      expect(html).not.toContain(messages.chat.sendError);
    }
  });

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
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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

  test("says a reply cut off before it finished can be tried again", () => {
    const html = renderWithProviders(
      <ChatThreadMessages
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
        approvalPendingMessageId={null}
        error={new Error("provider_stream_incomplete")}
        isGenerating={false}
        messages={[]}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        onResend={() => {}}
        showThinkingIndicator={false}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain(messages.chat.sendErrorStreamIncomplete);
    expect(html).toContain(messages.chat.resend);
  });

  test.each(AI_ERROR_KINDS.filter((kind) => kind !== "unknown"))(
    "a failed chat turn says what the REST failure says for %s",
    (kind) => {
      const restMessage = toAPIError({
        status: 502,
        value: {
          code: AI_FAILURE_CODES[kind],
          message: "Private provider detail",
        },
      }).message;
      const html = renderWithProviders(
        <ChatErrorMessage error={new Error(kind)} isGenerating={false} />,
      );

      expect(renderedText(html)).toContain(restMessage);
      expect(renderedText(html)).not.toContain(messages.chat.sendError);
    },
  );

  test("an unknown AI failure keeps the chat's own copy", () => {
    const html = renderWithProviders(
      <ChatErrorMessage error={new Error("unknown")} isGenerating={false} />,
    );

    expect(renderedText(html)).toContain(messages.chat.sendError);
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
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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

  test("keeps historical message actions available while the latest answer streams", () => {
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
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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

    expect(html.match(/aria-label="Actions"/gu)).toHaveLength(1);
    expect(html).not.toContain('aria-label="Save message"');
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
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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
    // Folded: the trace is still in the page, behind a closed disclosure.
    expect(disclosureExpanded(html, "Reasoning trace")).toBe("false");
    expect(html).toContain("12 reasoning tokens");
    expect(html).toContain("Checked the contract timeline.");
    expect(html).toContain("The deadline is Friday.");
    expect(html.match(/aria-label="Copy"/gu)?.length).toBe(1);
  });

  // Providers that hide their reasoning report only a token count; a
  // "Reasoning trace" label with nothing to open would read as broken.
  test("omits the reasoning label when the provider sent no trace", () => {
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
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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

    expect(html).not.toContain("Reasoning trace");
    expect(html).not.toContain("reasoning tokens");
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
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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

  const approvalRequestMessages = (): ChatUIMessage[] => [
    {
      id: "message-user",
      parts: [{ type: "text", content: "Search for it" }],
      role: "user",
    },
    {
      id: "message-approval",
      parts: [
        {
          approval: { id: "approval-1", needsApproval: true },
          arguments: JSON.stringify({ query: "civil code" }),
          id: "tool-call-approval",
          input: { query: "civil code" },
          name: "web_search",
          state: "approval-requested",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
  ];

  test("offers a decision on the approval the conversation waits on", () => {
    const html = renderWithProviders(
      <ChatThreadMessages
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
        approvalPendingMessageId="message-approval"
        messages={approvalRequestMessages()}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("Allow once");
  });

  // A user who types instead of answering supersedes the turn: the server
  // cancels the approval when it accepts the new message, so the card keeps
  // showing the request but stops offering a decision.
  test("withdraws the decision once a later message supersedes the turn", () => {
    const html = renderWithProviders(
      <ChatThreadMessages
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
        approvalPendingMessageId={null}
        isGenerating
        messages={[
          ...approvalRequestMessages(),
          {
            id: "message-user-2",
            parts: [
              { type: "text", content: "Before searching, list the sources." },
            ],
            role: "user",
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

    expect(html).not.toContain("Allow once");
    expect(html).toContain("Before searching, list the sources.");
  });

  const askUserInput = {
    analysis: "The matter decides the template.",
    questions: [{ question: "Which matter?", reason: "Picks the template." }],
  };
  const askUserMessages = (): ChatUIMessage[] => [
    {
      id: "message-user",
      parts: [{ type: "text", content: "Create the document" }],
      role: "user",
    },
    {
      id: "message-ask",
      parts: [
        {
          arguments: JSON.stringify(askUserInput),
          id: "tool-call-ask",
          input: askUserInput,
          name: "ask-user",
          state: "input-complete",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
  ];

  test("offers the form of the user-input card the conversation waits on", () => {
    const html = renderWithProviders(
      <ChatThreadMessages
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
        approvalPendingMessageId={null}
        messages={askUserMessages()}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );

    expect(html).toContain("<form");
    expect(html).toContain("Which matter?");
  });

  test("renders a private credential form in the user-owned turn", () => {
    const secretInput = {
      purpose: "Authenticate the sample connector",
      kind: "token" as const,
      target: { type: "mcp-connector" as const, connectorSlug: "sample" },
    };
    const html = renderWithProviders(
      <ChatThreadMessages
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
        approvalPendingMessageId={null}
        messages={[
          {
            id: "message-user",
            parts: [{ type: "text", content: "Continue the lookup" }],
            role: "user",
          },
          {
            id: "message-secret",
            parts: [
              {
                arguments: JSON.stringify(secretInput),
                id: "tool-call-secret",
                input: secretInput,
                name: "request_secret",
                state: "input-complete",
                type: "tool-call",
              },
            ],
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
      true,
    );

    expect(html).toContain("Authenticate the sample connector");
    expect(html).toContain('type="password"');
    expect(html).toContain("The assistant will not see this value.");
    expect(html).toContain("Provide");
    expect(html).toContain("Decline");
    expect(html).toContain("Use saved credential");
    const window = new Window();
    const root = window.document.createElement("div");
    // safe-html: React's static markup from this test's own components is parsed in a detached document.
    root.innerHTML = html;
    expect(
      root
        .querySelector('input[type="password"]')
        ?.closest('[data-slot="collapsible-panel"]'),
    ).toBeNull();
  });

  test("keeps the connector sign-in card outside a closed process disclosure", () => {
    const input = {
      connectorSlug: "sample",
      purpose: "Read the selected source",
    };
    const html = renderWithProviders(
      <ChatThreadMessages
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
        approvalPendingMessageId={null}
        messages={[
          {
            id: "message-user",
            parts: [{ type: "text", content: "Read the source" }],
            role: "user",
          },
          {
            id: "message-connector",
            parts: [
              {
                arguments: JSON.stringify(input),
                id: "tool-call-connector",
                input,
                name: "connect_connector",
                state: "input-complete",
                type: "tool-call",
              },
            ],
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
    const window = new Window();
    const root = window.document.createElement("div");
    // safe-html: React's static markup from this test's own components is parsed in a detached document.
    root.innerHTML = html;
    const card = root.querySelector('[data-slot="connect-connector-card"]');
    expect(card).not.toBeNull();
    expect(card?.closest('[data-slot="collapsible-panel"]')).toBeNull();
  });

  // The same supersession withdraws a user-input card: the runtime has no
  // interrupt left to answer it, and the server rejects a late answer.
  test("withdraws the user-input form once a later message supersedes the turn", () => {
    const html = renderWithProviders(
      <ChatThreadMessages
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
        approvalPendingMessageId={null}
        isGenerating
        messages={[
          ...askUserMessages(),
          {
            id: "message-user-2",
            parts: [{ type: "text", content: "Use the Acme matter." }],
            role: "user",
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

    expect(html).not.toContain("<form");
    expect(html).not.toContain("Which matter?");
    expect(html).toContain("Use the Acme matter.");
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
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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

    // The whole run sits behind one summary of the work that landed,
    // collapsed by default: the failed call is left out of it, and inside
    // it reads as a short human line with the raw output tucked behind its
    // own disclosure.
    expect(html).toContain(">1 analysis<");
    expect(html).not.toContain("3 steps");
    expect(disclosureExpanded(html, "1 analysis")).toBe("false");
    expect(disclosureExpanded(html, "Show details")).toBe("false");
    expect(html).toContain("This step failed — stella will work around it.");
    expect(html).toContain(">Show details<");
    expect(html).toContain("Here is the answer.");
  });

  test("shows an approval-gated call as a card while its input streams", () => {
    const chatMessages: ChatUIMessage[] = [
      {
        id: "message-A",
        parts: [
          { type: "thinking", content: "Drafting the positions." },
          {
            type: "tool-call",
            id: "tool-call-save",
            name: "save_playbook",
            arguments: '{"name":"Mutual NDA","positions":[',
            state: "input-streaming",
          },
        ],
        role: "assistant",
      },
    ];

    const html = renderWithProviders(
      <ChatThreadMessages
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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

    // The save always ends in a question for the user, so it renders as its
    // own card with a running indicator from the first input byte; only the
    // reasoning stays folded, and as a settled step rather than a live one.
    expect(html).toContain("1 step");
    expect(html).toContain(">Save playbook<");
    expect(html).toContain('data-slot="loader"');
    expect(html).not.toContain("animate-skeleton");
  });

  test("keeps streaming reasoning visible and immediately collapsible", async () => {
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

    const content = (
      <ChatThreadMessages
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
        approvalPendingMessageId={null}
        isGenerating
        messages={chatMessages}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />
    );

    const html = renderWithProviders(content);
    const loadedHtml = await renderWithLoadedMarkdown(content);
    expect(loadedHtml).toContain('data-streamdown="strong"');
    for (const output of [html, loadedHtml]) {
      expect(disclosureExpanded(output, "Reasoning trace")).toBe("true");
      expect(renderedText(output)).toContain(
        "Reading cited documents with create-document.",
      );
      expect(output).not.toContain("**");
      expect(output).not.toContain('data-slot="loader"');
      expect(output).not.toContain("Working with context");
    }
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
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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
    // foldable disclosure (collapsed by default) rather than staying pinned
    // open — the reasoning text is still present, just tucked away.
    expect(disclosureExpanded(html, "Reasoning trace")).toBe("false");
    expect(html).toContain("Checking cited filings.");
    expect(html).not.toContain("Working with context");
  });

  test("preserves generated document filename casing in the preview", async () => {
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

    const content = (
      <ChatThreadMessages
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
        approvalPendingMessageId={null}
        messages={chatMessages}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />
    );

    const html = renderWithProviders(content);
    const loadedHtml = await renderWithLoadedMarkdown(content);
    expect(loadedHtml).toContain('data-streamdown="strong"');
    for (const output of [html, loadedHtml]) {
      expect(output).toContain("Dohoda_o_ochrane_duvernych_informaci_NDA.docx");
      expect(renderedText(output)).toContain(
        "Smluvní strany: Poskytovatel a příjemce",
      );
      expect(output).not.toContain("**Smluvní strany:**");
      expect(output).not.toContain("tracking-wide uppercase");
    }
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
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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

  test("does not render remote image attachment URLs", () => {
    const remoteUrl = "https://untrusted.example/evidence.png";
    const chatMessages: ChatUIMessage[] = [
      {
        id: "message-A",
        parts: [
          {
            type: "image",
            source: {
              type: "url",
              value: remoteUrl,
              mimeType: "image/png",
            },
            metadata: { filename: "evidence.png" },
          },
        ],
        role: "user",
      },
    ];

    const html = renderWithProviders(
      <ChatThreadMessages
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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

    expect(html).toContain("evidence.png");
    expect(html).not.toContain("<img");
    expect(html).not.toContain(remoteUrl);
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
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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
    expect(html.match(/aria-label="Copy"/gu)?.length).toBe(2);
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
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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
    expect(html.match(/aria-label="Copy"/gu)?.length).toBe(1);
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
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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
    expect(html).toContain('aria-label="Copy"');
    expect(html).not.toContain(">Retry</button>");
  });

  test("shows a resendable chat message when the chat runtime errors", () => {
    const html = renderWithProviders(
      <ChatThreadMessages
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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

  test.each([
    { status: 401, copy: messages.errors.api.unauthorized },
    { status: 403, copy: messages.errors.api.forbidden },
    { status: 404, copy: messages.errors.api.notFound },
    { status: 409, copy: messages.errors.api.conflict },
    { status: 429, copy: messages.errors.api.rateLimited },
    { status: 500, copy: messages.errors.api.server },
    { status: 503, copy: messages.errors.api.serviceUnavailable },
  ])(
    "an HTTP $status refusal keeps localized copy through transport wrappers",
    ({ status, copy }) => {
      const refusal = toAPIError({
        status,
        value: {
          code: "unrecognized_http_refusal",
          message: "Private request diagnostics",
        },
      });
      const html = renderWithProviders(
        <ChatErrorMessage
          error={new Error("Stream read failed", { cause: refusal })}
          isGenerating={false}
          onResend={() => {}}
        />,
      );

      expect(html).toContain(copy);
      expect(html).toContain("Resend");
      expect(html).not.toContain(messages.chat.sendError);
      expect(html).not.toContain("Private request diagnostics");
    },
  );

  test.each([400, 422])(
    "an HTTP %s input rejection asks the user to check the request",
    (status) => {
      const html = renderWithProviders(
        <ChatErrorMessage
          error={
            new APIError({ status, message: messages.errors.api.badRequest })
          }
          isGenerating={false}
          onResend={() => {}}
        />,
      );
      expect(html).toContain(messages.errors.api.validation);
      expect(html).not.toContain(messages.chat.sendError);
    },
  );

  test("explains a permanent approval continuation rejection without offering resend", () => {
    const refusal = toAPIError({
      status: 400,
      value: {
        code: CHAT_CONTINUATION_REJECTED_ERROR_CODE,
        message: "Private continuation mismatch details",
      },
    });
    const html = renderWithProviders(
      <ChatErrorMessage
        error={new Error("SDK transport wrapper", { cause: refusal })}
        isGenerating={false}
        onResend={() => {}}
      />,
    );
    expect(html).toContain(messages.chat.sendErrorContinuationRejected);
    expect(html).not.toContain("Resend");
    expect(html).not.toContain("Private continuation mismatch details");
  });

  test("hides every retry action after a permanent approval continuation rejection", () => {
    const refusal = toAPIError({
      status: 400,
      value: {
        code: CHAT_CONTINUATION_REJECTED_ERROR_CODE,
        message: "Private continuation mismatch details",
      },
    });
    const html = renderWithProviders(
      <ChatThreadMessages
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
        approvalPendingMessageId={null}
        error={new Error("SDK transport wrapper", { cause: refusal })}
        messages={[
          {
            id: "answer-A",
            role: "assistant",
            parts: [{ type: "text", content: "Answer awaiting continuation" }],
          },
        ]}
        onAskUserSubmit={() => {}}
        onCreateDocumentResolve={() => {}}
        onOpenCreatedDocument={() => {}}
        onResend={() => {}}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />,
    );
    expect(html).toContain("Answer awaiting continuation");
    expect(html).toContain(messages.chat.sendErrorContinuationRejected);
    expect(html).not.toContain('aria-label="Retry"');
    expect(html).not.toContain(">Retry</button>");
    expect(html).not.toContain(">Resend</button>");
  });

  test("maps model-unavailable stream errors to admin-facing copy", () => {
    const html = renderWithProviders(
      <ChatThreadMessages
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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

  test("offers the actions menu on every answer, not just the latest", () => {
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
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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

    // Both assistant messages retain their secondary actions in the menu. The
    // user message has no assistant-message action row.
    expect(html.match(/aria-label="Actions"/gu)).toHaveLength(2);
    expect(html.match(/>Retry<\/button>/gu)).toHaveLength(1);
  });

  test("keeps the actions menu off the sticky user header", () => {
    const html = renderWithProviders(
      <ChatThreadMessages
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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

    // The pinned ask is a user message: only the answer beneath it has the
    // assistant-message actions menu.
    expect(html.match(/aria-label="Actions"/gu)).toHaveLength(1);
  });

  test("offers no assistant-message actions on a user message", () => {
    const html = renderWithProviders(
      <ChatThreadMessages
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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

    // Only the answer has the secondary actions menu. Neither ask does; an
    // unreplied ask may not even be durable yet.
    expect(html.match(/aria-label="Actions"/gu)).toHaveLength(1);
  });

  test("omits thread actions on surfaces that carry no thread reference", () => {
    const html = renderWithProviders(
      <ChatThreadMessages
        activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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
    expect(html).not.toContain('aria-label="Actions"');
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

test.each([...Object.values(PROVIDER_SETUP_ERROR_CODE), null])(
  "runtime chat error %s renders full provider reason and guidance after reload",
  (code) => {
    const provider =
      code === null
        ? "custom-provider"
        : PROVIDER_SETUP_ERROR_CATALOGUE[code].provider;
    const diagnostic = {
      provider,
      code,
      message: `The exact upstream reason\n${"full detail ".repeat(30)}`,
    };
    const stored = {
      id: "failed-diagnostic",
      role: "assistant",
      parts: [],
      metadata: {
        turnOutcome: {
          type: "failed",
          error: "provider_credentials_rejected",
          providerDiagnostic: diagnostic,
        },
      },
    } satisfies PersistedChatMessage;
    const error = getChatAssistantTurnError(structuredClone(stored));
    expect(error).toBeDefined();
    // Reload is the authoritative message path; live streaming uses the same tagged diagnostic.
    expect(ProviderDiagnosticError.is(error)).toBe(true);
    if (!ProviderDiagnosticError.is(error)) {
      return;
    }
    const restored = error;
    const html = renderWithProviders(
      <ChatErrorMessage error={restored} isGenerating={false} />,
    );
    expect(renderedText(html)).toContain(`${provider}: ${diagnostic.message}`);
    expect(html).toContain(messages.common.copy);
    expect(html).not.toContain(
      messages.chat.sendErrorProviderCredentialsRejected,
    );
    if (code !== null) {
      expect(html).toContain(
        PROVIDER_SETUP_ERROR_CATALOGUE[code].url.replaceAll("&", "&amp;"),
      );
    }
  },
);
test("sent pasted text renders once as a collapsed attachment", () => {
  const text = "First line\n  <literal> & whitespace\n";
  const html = renderWithProviders(
    <ChatThreadMessages
      activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
      approvalPendingMessageId={null}
      messages={[
        {
          id: "message-pasted",
          role: "user",
          parts: [createChatPastedTextPart(text)],
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
  const window = new Window();
  const { body } = new window.DOMParser().parseFromString(html, "text/html");
  const content = body.querySelector("pre");
  expect(content?.hidden).toBe(true);
  expect(content?.textContent).toBe(text);
  expect(body.querySelectorAll("pre")).toHaveLength(1);
  expect(body.querySelector('[aria-expanded="false"]')).not.toBeNull();
  expect(body.querySelectorAll("literal")).toHaveLength(0);
});
