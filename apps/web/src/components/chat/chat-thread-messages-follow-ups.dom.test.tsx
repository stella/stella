import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";
import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import type { SuggestedFollowupsProps } from "@/features/chat/components/suggested-followups";

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
const { toChatThreadId } = await import("@/lib/chat-thread-ref");
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
  parts: [{ type: "text", content: "Summarise the lease." }],
  role: "user",
} satisfies ChatUIMessage;

const answer = {
  id: "answer",
  parts: [{ type: "text", content: "The lease runs for five years." }],
  role: "assistant",
} satisfies ChatUIMessage;

const followUpsFor = (messageId: string): SuggestedFollowupsProps => ({
  analyticsSurface: "chat-thread",
  messageId,
  onSelect: () => undefined,
  prompts: ["Who pays for repairs?", "Can the tenant end it early?"],
  threadId: toChatThreadId("thread-follow-ups"),
});

const renderThread = async (followUps: SuggestedFollowupsProps) => {
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
                    followUps={followUps}
                    isGenerating={false}
                    messages={[question, answer]}
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

test("the finished answer is followed by its next steps, after its actions", async () => {
  const view = await renderThread(followUpsFor(answer.id));

  const followUps = view.getByRole("region", { name: messages.chat.nextSteps });
  const answerNode = view.container.querySelector(
    `[data-chat-message-id="${answer.id}"]`,
  );
  expect(answerNode?.contains(followUps)).toBe(true);
  expect(
    [...followUps.querySelectorAll("button")].map((row) => row.textContent),
  ).toEqual(["Who pays for repairs?", "Can the tenant end it early?"]);

  const copy = view.getByRole("button", { name: messages.common.copy });
  // Neither contains the other, so "following" is the whole relation.
  expect(copy.compareDocumentPosition(followUps)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

test("suggestions for another message draw nothing under this answer", async () => {
  const view = await renderThread(followUpsFor("an-earlier-answer"));

  expect(
    view.queryByRole("region", { name: messages.chat.nextSteps }),
  ).toBeNull();
});
