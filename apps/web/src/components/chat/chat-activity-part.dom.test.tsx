import { StrictMode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { UNSUPPORTED_CHAT_PART_ACTIVITY_TYPE } from "@stll/api-contract/chat";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";
import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import type { ChatActivitySession } from "@/features/chat/chat-runtime";
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
  await unregisterDomEnvironment();
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

type ActivityViewOptions = {
  message: ChatUIMessage;
  analytics: Analytics;
  activitySession: ChatActivitySession;
};

const activityView = ({
  message,
  analytics,
  activitySession,
}: ActivityViewOptions) => (
  <StrictMode>
    <ChatThreadTestRouter>
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="cs" messages={messages} timeZone="UTC">
          <AnalyticsContext value={analytics}>
            <ChatMattersContext
              value={{ createDocumentMattersView: { type: "empty" } }}
            >
              <ChatApprovalContext value={testChatApprovalContextValue}>
                <ChatEditorProvider>
                  <ChatThreadMessages
                    activitySession={activitySession}
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

test("unknown chat activities report once per type across remounts without rendering or reporting private payloads", () => {
  const errors: unknown[] = [];
  const analytics = {
    ...noopAnalytics,
    captureError: (error: unknown) => errors.push(error),
  };
  const activitySession = { reportedUnknownActivityTypes: new Set<string>() };
  const message = activityMessage("private-activity-type");
  const view = render(activityView({ message, analytics, activitySession }));
  view.rerender(
    activityView({
      message: structuredClone(message),
      analytics,
      activitySession,
    }),
  );

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

  view.unmount();
  const remounted = render(
    activityView({
      message: structuredClone(message),
      analytics,
      activitySession,
    }),
  );
  expect(errors).toHaveLength(1);

  remounted.rerender(
    activityView({
      message: activityMessage("another-private-type"),
      analytics,
      activitySession,
    }),
  );
  expect(errors).toHaveLength(2);
  expect(JSON.stringify(errors)).not.toContain("another-private-type");

  remounted.rerender(
    activityView({
      message: structuredClone(message),
      analytics,
      activitySession,
    }),
  );
  expect(errors).toHaveLength(2);
});

test("a new chat session reports an unknown activity again with the same analytics owner", () => {
  const errors: unknown[] = [];
  const analytics = {
    ...noopAnalytics,
    captureError: (error: unknown) => errors.push(error),
  };
  const firstActivitySession = {
    reportedUnknownActivityTypes: new Set<string>(),
  };
  const secondActivitySession = {
    reportedUnknownActivityTypes: new Set<string>(),
  };
  const message = activityMessage("session-scoped-private-type");
  const firstSession = render(
    activityView({ message, analytics, activitySession: firstActivitySession }),
  );
  expect(errors).toHaveLength(1);
  firstSession.unmount();

  const secondSession = render(
    activityView({
      message,
      analytics,
      activitySession: secondActivitySession,
    }),
  );
  secondSession.rerender(
    activityView({
      message: structuredClone(message),
      analytics,
      activitySession: secondActivitySession,
    }),
  );
  expect(errors).toHaveLength(2);
});

test("review activities use the dedicated translated chat label without telemetry", () => {
  const errors: unknown[] = [];
  const analytics = {
    ...noopAnalytics,
    captureError: (error: unknown) => errors.push(error),
  };
  const view = render(
    activityView({
      message: activityMessage("review"),
      analytics,
      activitySession: { reportedUnknownActivityTypes: new Set<string>() },
    }),
  );
  expect(view.getByText(messages.chat.activity.review)).toBeDefined();
  expect(view.container.textContent).not.toContain("private-payload");
  expect(errors).toEqual([]);
});

test("a part only a newer release can read shows a neutral row in its place, never its content", () => {
  const errors: unknown[] = [];
  const analytics = {
    ...noopAnalytics,
    captureError: (error: unknown) => errors.push(error),
  };
  const message = {
    id: "answer-from-newer-release",
    role: "assistant",
    parts: [
      { type: "text", content: "The NDA is mutual." },
      {
        type: "activity",
        activityType: UNSUPPORTED_CHAT_PART_ACTIVITY_TYPE,
        content: { part: { type: "citation", quote: "private-payload" } },
      },
    ],
  } satisfies ChatUIMessage;
  const view = render(
    activityView({
      message,
      analytics,
      activitySession: { reportedUnknownActivityTypes: new Set<string>() },
    }),
  );
  expect(view.getByText(messages.chat.activity.newerVersion)).toBeDefined();
  expect(view.container.textContent).toContain("The NDA is mutual.");
  expect(view.container.textContent).not.toContain("private-payload");
  expect(view.container.textContent).not.toContain("citation");
  expect(errors).toEqual([]);
});
