import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { ChatLocalRunComputerWait } from "@stll/api-contract/chat-run-target";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";
import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";

GlobalRegistrator.register({ url: "https://app.example.test/chat/thread" });

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async () => await Promise.resolve(Response.json(null)),
  { preconnect: originalFetch.preconnect },
);

const { act, cleanup, render, screen } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { ChatApprovalContext } =
  await import("@/components/chat/chat-approval-context");
const { ChatMattersContext } =
  await import("@/components/chat/chat-matters-context");
const { ChatEditorProvider } =
  await import("@/components/chat-editor-provider");
const { ChatThreadMessages } =
  await import("@/components/chat/chat-thread-messages");

afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const question = {
  id: "question",
  parts: [{ type: "text", content: "Which leases end this year?" }],
  role: "user",
} satisfies ChatUIMessage;

// What the turn had shown when its computer went away.
const partialAnswer = {
  id: "answer",
  parts: [{ type: "text", content: "Lease " }],
  role: "assistant",
} satisfies ChatUIMessage;

const WAITING = messages.chat.localRun.waitingForComputer;
const PICKUP = messages.chat.localRun.waitingForPickup;
const AWAY = { status: "waiting" } as const satisfies ChatLocalRunComputerWait;

const renderTurn = async ({
  isGenerating,
  computerWait,
}: {
  isGenerating: boolean;
  computerWait: ChatLocalRunComputerWait | null;
}) => {
  render(
    <ChatThreadTestRouter>
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
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
                    isGenerating={isGenerating}
                    messages={[question, partialAnswer]}
                    onAskUserSubmit={() => {}}
                    onCreateDocumentResolve={() => {}}
                    onOpenCreatedDocument={() => {}}
                    streamdownComponents={{
                      a: ({ children, ...props }) => (
                        <a {...props}>{children}</a>
                      ),
                    }}
                    computerWait={computerWait}
                  />
                </ChatEditorProvider>
              </ChatApprovalContext>
            </ChatMattersContext>
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>
    </ChatThreadTestRouter>,
  );
  await act(async () => {
    await Promise.resolve();
  });
};

test("a running turn whose computer is away says so under its answer", async () => {
  await renderTurn({ isGenerating: true, computerWait: AWAY });
  const status = screen.getByText(WAITING).closest("[role='status']");
  expect(status).not.toBeNull();
  // The partial answer stays as it was; the wait follows it.
  expect(screen.getByText("Lease")).toBeTruthy();
  // One status line per turn: the wait takes the place of the live one.
  expect(document.querySelector("[data-turn-live-status]")).toBeNull();
});

test("a running turn whose computer is there shows no wait", async () => {
  await renderTurn({ isGenerating: true, computerWait: null });
  expect(screen.queryByText(WAITING)).toBeNull();
  expect(document.querySelector("[data-turn-live-status]")).not.toBeNull();
});

test("a settled turn never shows a wait left from its stream", async () => {
  await renderTurn({ isGenerating: false, computerWait: AWAY });
  expect(screen.queryByText(WAITING)).toBeNull();
});

test("a turn its computer has not picked up yet says so, with the time since it was sent", async () => {
  // Sent long before the render: the count is whole seconds since then.
  await renderTurn({
    isGenerating: true,
    computerWait: { status: "delivering", since: "2026-01-01T00:00:00.000Z" },
  });
  const status = screen.getByText(PICKUP).closest("[role='status']");
  expect(status?.textContent).toMatch(/^.+…\d[\d,]*s$/u);
  expect(screen.queryByText(WAITING)).toBeNull();
  expect(document.querySelector("[data-turn-live-status]")).toBeNull();
});
