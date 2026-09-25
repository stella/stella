import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import {
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_TOOL_NAME,
} from "@stll/api-contract/browser-control";

import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import { isApprovalPart } from "@/components/chat/chat-ui-tools";
import { ToolApprovalCard } from "@/components/chat/tool-approval-card";
import messages from "@/i18n/langs/en.json";

const noop = () => undefined;

const renderCard = (part: unknown) => {
  if (!isApprovalPart(part)) {
    throw new Error("Expected a browser approval part");
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ChatApprovalContext
          value={{
            activeOrganizationId: "org-1",
            alwaysApprovedTools: new Set(),
            conversationApprovedTools: new Set(),
            handleAllowInConversation: noop,
            handleAlwaysAllow: noop,
            handleApprove: noop,
            handleDeny: noop,
          }}
        >
          <ToolApprovalCard part={part} />
        </ChatApprovalContext>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

const browserPart = (input: unknown, state: string, output?: unknown) => ({
  approval: { id: "approval-1", needsApproval: true },
  arguments: JSON.stringify(input),
  id: "tool-call-1",
  input,
  name: BROWSER_CONTROL_TOOL_NAME,
  state,
  type: "tool-call",
  ...(output === undefined ? {} : { output }),
});

const readPage = { action: "snapshot" };
const browserQuestion = messages.chat.approval.browser.question;

describe("browser approval card", () => {
  test("asks about a pending browser action", () => {
    expect(renderCard(browserPart(readPage, "approval-requested"))).toContain(
      browserQuestion,
    );
  });

  test("a past browser action no longer asks", () => {
    const markup = renderCard(
      browserPart(readPage, "complete", {
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        snapshot: {
          contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
          elements: [],
          revision: "revision-1",
          tabId: 7,
          text: "Ready",
          textOffset: 0,
          textTotalChars: 5,
          title: "Example",
          url: "https://example.com/",
        },
        status: "success",
      }),
    );

    expect(markup).toContain(messages.chat.approval.browser.actions.snapshot);
    expect(markup).not.toContain(browserQuestion);
  });

  test("a malformed browser command still shows what the model sent", () => {
    const markup = renderCard(
      browserPart(
        {
          action: "click",
          target: { name: "Pay now", ref: "not-a-ref", role: "button" },
        },
        "approval-requested",
      ),
    );

    expect(markup).toContain("not-a-ref");
    expect(markup).not.toContain(browserQuestion);
  });
});
