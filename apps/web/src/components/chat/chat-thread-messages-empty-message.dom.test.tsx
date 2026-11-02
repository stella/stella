import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";
import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test/chat/thread" });

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async () => await Promise.resolve(Response.json(null)),
  { preconnect: originalFetch.preconnect },
);

const { act, cleanup, render } = await import("@testing-library/react");
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
  parts: [{ type: "text", content: "Open Wikipedia." }],
  role: "user",
} satisfies ChatUIMessage;

// What a turn can persist ahead of the message holding its answer: reasoning
// the provider does not show, so nothing in it draws.
const hiddenReasoning = {
  id: "hidden-reasoning",
  parts: [{ type: "thinking", content: "" }],
  role: "assistant",
} satisfies ChatUIMessage;

const answer = {
  id: "answer",
  parts: [{ type: "text", content: "I opened Wikipedia." }],
  role: "assistant",
} satisfies ChatUIMessage;

const renderThread = async (
  threadMessages: ChatUIMessage[],
  stickyUserMessages: boolean,
) => {
  const view = render(
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
                    isGenerating={false}
                    messages={threadMessages}
                    onAskUserSubmit={() => {}}
                    onCreateDocumentResolve={() => {}}
                    onOpenCreatedDocument={() => {}}
                    stickyUserMessages={stickyUserMessages}
                    streamdownComponents={{
                      a: ({ children, ...props }) => (
                        <a {...props}>{children}</a>
                      ),
                    }}
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
  return view;
};

const renderedMessageIds = (container: HTMLElement): string[] =>
  [...container.querySelectorAll<HTMLElement>("[data-chat-message-id]")].map(
    (node) => node.dataset["chatMessageId"] ?? "",
  );

for (const stickyUserMessages of [false, true]) {
  describe(`sticky questions ${stickyUserMessages ? "on" : "off"}`, () => {
    test("an assistant message that draws nothing leaves no block between the question and the answer", async () => {
      const view = await renderThread(
        [question, hiddenReasoning, answer],
        stickyUserMessages,
      );
      expect(renderedMessageIds(view.container)).toEqual([
        question.id,
        answer.id,
      ]);
    });

    test("the last message renders even when it draws nothing, so its footer stays reachable", async () => {
      const view = await renderThread(
        [question, hiddenReasoning],
        stickyUserMessages,
      );
      expect(renderedMessageIds(view.container)).toEqual([
        question.id,
        hiddenReasoning.id,
      ]);
    });

    test("reasoning with text still renders as its own message", async () => {
      const visibleReasoning = {
        ...hiddenReasoning,
        parts: [{ type: "thinking", content: "Finding the portal." }],
      } satisfies ChatUIMessage;
      const view = await renderThread(
        [question, visibleReasoning, answer],
        stickyUserMessages,
      );
      expect(renderedMessageIds(view.container)).toEqual([
        question.id,
        visibleReasoning.id,
        answer.id,
      ]);
    });
  });
}
