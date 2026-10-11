import { StrictMode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";
import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";

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
const { default: messages } = await import("@/i18n/langs/cs.json");
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
  await GlobalRegistrator.unregister();
});

const activityMessage = (activityType: string) =>
  ({
    id: "activity-message",
    role: "activity",
    parts: [
      {
        type: "activity",
        activityType,
        content: { secret: "private-payload" },
      },
    ],
  }) satisfies ChatUIMessage;

const activityView = (message: ChatUIMessage, errors: unknown[]) => (
  <StrictMode>
    <ChatThreadTestRouter>
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="cs" messages={messages} timeZone="UTC">
          <AnalyticsContext
            value={{
              ...noopAnalytics,
              captureError: (error) => errors.push(error),
            }}
          >
            <ChatMattersContext
              value={{ createDocumentMattersView: { type: "empty" } }}
            >
              <ChatApprovalContext value={testChatApprovalContextValue}>
                <ChatEditorProvider>
                  <ChatThreadMessages
                    approvalPendingMessageId={null}
                    messages={[message]}
                    onAskUserSubmit={() => {}}
                    onCreateDocumentResolve={() => {}}
                    onOpenCreatedDocument={() => {}}
                    streamdownComponents={{
                      a: ({ children, ...props }) => (
                        <a {...props}>{children}</a>
                      ),
                    }}
                  />
                </ChatEditorProvider>
              </ChatApprovalContext>
            </ChatMattersContext>
          </AnalyticsContext>
        </IntlProvider>
      </QueryClientProvider>
    </ChatThreadTestRouter>
  </StrictMode>
);

test("unknown chat activities report once without rendering or reporting private payloads", () => {
  const errors: unknown[] = [];
  const message = activityMessage("private-activity-type");
  const view = render(activityView(message, errors));
  view.rerender(activityView(structuredClone(message), errors));

  expect(
    errors,
    JSON.stringify({ oracle: "chat.client.no-errors" }),
  ).toHaveLength(1);
  expect(errors.at(0)).toBeInstanceOf(ClientTelemetryError);
  expect(errors.at(0)).toMatchObject({
    area: "chat-unknown-activity",
    message: "A chat activity has no registered renderer",
  });
  expect(JSON.stringify(errors)).not.toContain("private-activity-type");
  expect(JSON.stringify(errors)).not.toContain("private-payload");
  expect(view.container.querySelector("figure")).toBeNull();
  expect(view.container.textContent).not.toContain("private-activity-type");
  expect(view.container.textContent).not.toContain("private-payload");

  view.rerender(activityView(activityMessage("another-private-type"), errors));
  expect(errors).toHaveLength(2);
  expect(JSON.stringify(errors)).not.toContain("another-private-type");
});

test("review activities use the dedicated translated chat label without telemetry", () => {
  const errors: unknown[] = [];
  const view = render(activityView(activityMessage("review"), errors));
  expect(view.getByText(messages.chat.activity.review)).toBeDefined();
  expect(view.container.textContent).not.toContain("private-payload");
  expect(errors).toEqual([]);
});
