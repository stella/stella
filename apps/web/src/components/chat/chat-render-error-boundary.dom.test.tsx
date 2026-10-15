import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";
import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import type { Analytics } from "@/lib/analytics/types";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test/chat/thread" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async () => await Promise.resolve(Response.json(null)),
  { preconnect: originalFetch.preconnect },
);
const { cleanup, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { ChatApprovalContext } = await import("./chat-approval-context");
const { ChatMattersContext } = await import("./chat-matters-context");
const { ChatEditorProvider } =
  await import("@/components/chat-editor-provider");
const { ChatThreadMessages } = await import("./chat-thread-messages");
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { noopAnalytics } = await import("@/lib/analytics/noop");
const { ClientTelemetryError } = await import("@/lib/errors/telemetry");

afterEach(cleanup);
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const textMessage = (
  id: string,
  role: "user" | "assistant",
  text: string,
): ChatUIMessage => ({ id, role, parts: [{ type: "text", content: text }] });

// A persisted message whose role has no render policy makes the message
// body throw while rendering, the same way any crashing part would.
const unrenderableMessage = {
  id: "unrenderable-message",
  role: "unknown-role",
  parts: [{ type: "text", content: "private unrenderable body" }],
} as unknown as ChatUIMessage;

const threadView = (threadMessages: ChatUIMessage[], analytics: Analytics) => (
  <ChatThreadTestRouter>
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <AnalyticsContext value={analytics}>
          <ChatMattersContext
            value={{ createDocumentMattersView: { type: "empty" } }}
          >
            <ChatApprovalContext value={testChatApprovalContextValue}>
              <ChatEditorProvider>
                <ChatThreadMessages
                  activitySession={{
                    reportedUnknownActivityTypes: new Set<string>(),
                  }}
                  approvalPendingMessageId={null}
                  messages={threadMessages}
                  onAskUserSubmit={() => {}}
                  onCreateDocumentResolve={() => {}}
                  onOpenCreatedDocument={() => {}}
                  streamdownComponents={{
                    a: ({ children, ...props }) => <a {...props}>{children}</a>,
                  }}
                />
              </ChatEditorProvider>
            </ChatApprovalContext>
          </ChatMattersContext>
        </AnalyticsContext>
      </IntlProvider>
    </QueryClientProvider>
  </ChatThreadTestRouter>
);

test("a message that fails to render is replaced by a fallback while its siblings stay", () => {
  const errors: unknown[] = [];
  const analytics = {
    ...noopAnalytics,
    captureError: (error: unknown) => errors.push(error),
  };
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const view = render(
      threadView(
        [
          textMessage("first-message", "user", "First question"),
          unrenderableMessage,
          textMessage("last-message", "assistant", "Last answer"),
        ],
        analytics,
      ),
    );

    const text = view.container.textContent;
    expect(text).toContain("First question");
    expect(text).toContain("Last answer");
    expect(text).toContain(messages.chat.messageUnavailable);
    expect(text).not.toContain("private unrenderable body");
    expect(
      view.container.querySelector(
        '[data-chat-message-id="unrenderable-message"]',
      ),
    ).not.toBeNull();

    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(error).toBeInstanceOf(ClientTelemetryError);
      expect(error).toMatchObject({
        area: "chat-message",
        message: "[Chat thread] Message failed to render",
      });
    }
    expect(JSON.stringify(errors)).not.toContain("private unrenderable body");
  } finally {
    console.error = originalConsoleError;
  }
});

test("a thread without failing messages reports nothing", () => {
  const errors: unknown[] = [];
  const analytics = {
    ...noopAnalytics,
    captureError: (error: unknown) => errors.push(error),
  };
  const view = render(
    threadView(
      [
        textMessage("first-message", "user", "First question"),
        textMessage("last-message", "assistant", "Last answer"),
      ],
      analytics,
    ),
  );

  expect(view.container.textContent).not.toContain(
    messages.chat.messageUnavailable,
  );
  expect(errors).toHaveLength(0);
});
