import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import messages from "@/i18n/langs/en.json";
import type Messages from "@/i18n/langs/messages.gen";

process.env["VITE_API_URL"] = "http://localhost:3001";

const { ChatThreadMessages } =
  await import("@/components/chat/chat-thread-messages");

describe("chat thread messages", () => {
  test("shows a copy action at the end of assistant responses", () => {
    const chatMessages: PersistedChatMessage[] = [
      {
        id: "message-A",
        parts: [{ type: "text", text: "Draft answer" }],
        role: "assistant",
      },
    ];

    const html = renderToStaticMarkup(
      <IntlProvider
        locale="en"
        // SAFETY: this mirrors the app provider boundary; locale
        // files are checked separately, while use-intl preserves
        // English literal values in the generated Messages type.
        // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
        messages={messages as Messages}
        timeZone="UTC"
      >
        <ChatThreadMessages
          approvalPendingMessageId={null}
          autoApprovedTools={new Set()}
          handleAlwaysAllow={() => {}}
          handleApprove={() => {}}
          handleDeny={() => {}}
          messages={chatMessages}
          onAskUserSubmit={() => {}}
          showToolCalls={false}
          streamdownComponents={{
            a: ({ children, ...props }) => <a {...props}>{children}</a>,
          }}
        />
      </IntlProvider>,
    );

    expect(html).toContain("Draft answer");
    expect(html).toContain('aria-label="Copy"');
    expect(html).toContain(">Copy</button>");
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

    const html = renderToStaticMarkup(
      <IntlProvider
        locale="en"
        // SAFETY: this mirrors the app provider boundary; locale
        // files are checked separately, while use-intl preserves
        // English literal values in the generated Messages type.
        // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
        messages={messages as Messages}
        timeZone="UTC"
      >
        <ChatThreadMessages
          approvalPendingMessageId={null}
          autoApprovedTools={new Set()}
          handleAlwaysAllow={() => {}}
          handleApprove={() => {}}
          handleDeny={() => {}}
          messages={chatMessages}
          onAskUserSubmit={() => {}}
          onResend={() => {}}
          showToolCalls={false}
          streamdownComponents={{
            a: ({ children, ...props }) => <a {...props}>{children}</a>,
          }}
        />
      </IntlProvider>,
    );

    expect(html).toContain("First answer");
    expect(html).toContain("Second answer");
    expect(html.match(/>Copy<\/button>/g)?.length).toBe(2);
    expect(html.match(/>Retry<\/button>/g)?.length).toBe(1);
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

    const html = renderToStaticMarkup(
      <IntlProvider
        locale="en"
        // SAFETY: this mirrors the app provider boundary; locale
        // files are checked separately, while use-intl preserves
        // English literal values in the generated Messages type.
        // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
        messages={messages as Messages}
        timeZone="UTC"
      >
        <ChatThreadMessages
          approvalPendingMessageId={null}
          autoApprovedTools={new Set()}
          handleAlwaysAllow={() => {}}
          handleApprove={() => {}}
          handleDeny={() => {}}
          messages={chatMessages}
          onAskUserSubmit={() => {}}
          onResend={() => {}}
          showToolCalls={false}
          streamdownComponents={{
            a: ({ children, ...props }) => <a {...props}>{children}</a>,
          }}
        />
      </IntlProvider>,
    );

    expect(html).toContain("Answer before retry");
    expect(html).toContain("Follow-up prompt");
    expect(html.match(/>Copy<\/button>/g)?.length).toBe(1);
    expect(html).not.toContain(">Retry</button>");
  });

  test("shows a resendable chat message when the chat runtime errors", () => {
    const html = renderToStaticMarkup(
      <IntlProvider
        locale="en"
        // SAFETY: this mirrors the app provider boundary; locale
        // files are checked separately, while use-intl preserves
        // English literal values in the generated Messages type.
        // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
        messages={messages as Messages}
        timeZone="UTC"
      >
        <ChatThreadMessages
          alwaysApprovedTools={new Set()}
          approvalPendingMessageId={null}
          conversationApprovedTools={new Set()}
          error={new Error("provider details must stay hidden")}
          handleAllowInConversation={() => {}}
          handleAlwaysAllow={() => {}}
          handleApprove={() => {}}
          handleDeny={() => {}}
          messages={[]}
          onAskUserSubmit={() => {}}
          onResend={() => {}}
          showToolCallDetails={false}
          streamdownComponents={{
            a: ({ children, ...props }) => <a {...props}>{children}</a>,
          }}
        />
      </IntlProvider>,
    );

    expect(html).toContain("There was an issue sending your message.");
    expect(html).toContain("Resend");
    expect(html).not.toContain("provider details must stay hidden");
  });
});
