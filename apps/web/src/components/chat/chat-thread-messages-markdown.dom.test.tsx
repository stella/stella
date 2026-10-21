import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test/chat/thread" });

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async () => await Promise.resolve(Response.json(null)),
  { preconnect: originalFetch.preconnect },
);

const { act, cleanup, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { ChatApprovalContext } =
  await import("@/components/chat/chat-approval-context");
const { ChatMattersContext } =
  await import("@/components/chat/chat-matters-context");
const { ChatEditorProvider } =
  await import("@/components/chat-editor-provider");
const { ChatThreadMessages } =
  await import("@/components/chat/chat-thread-messages");

const queryClients: InstanceType<typeof QueryClient>[] = [];
afterEach(async () => {
  await act(async () => cleanup());
  for (const client of queryClients) {
    client.clear();
  }
  queryClients.length = 0;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const thread = (
  threadMessages: PersistedChatMessage[],
  isGenerating: boolean,
  queryClient: InstanceType<typeof QueryClient>,
) => (
  <ChatThreadTestRouter>
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
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
                messages={threadMessages}
                onAskUserSubmit={() => {}}
                onCreateDocumentResolve={() => {}}
                onOpenCreatedDocument={() => {}}
                streamdownComponents={{}}
              />
            </ChatEditorProvider>
          </ChatApprovalContext>
        </ChatMattersContext>
      </IntlProvider>
    </QueryClientProvider>
  </ChatThreadTestRouter>
);

const renderThread = (
  threadMessages: PersistedChatMessage[],
  isGenerating: boolean,
) => {
  const queryClient = new QueryClient();
  queryClients.push(queryClient);
  const view = render(thread(threadMessages, isGenerating, queryClient));
  return {
    view,
    rerender: (next: PersistedChatMessage[], nextGenerating: boolean) => {
      view.rerender(thread(next, nextGenerating, queryClient));
    },
  };
};

const answer = (content: string): PersistedChatMessage => ({
  id: "answer",
  parts: [{ type: "text", content }],
  role: "assistant",
});
const question: PersistedChatMessage = {
  id: "question",
  parts: [{ type: "text", content: "<p>Show the snippet.</p>" }],
  role: "user",
};

test("code block actions of the streaming answer wait until the turn ends", async () => {
  const partial = "Here it is:\n\n```ts\nconst total = 1;";
  const { view, rerender } = renderThread([question, answer(partial)], true);
  const actions = () => [
    ...view.container.querySelectorAll(
      '[data-streamdown="code-block-actions"] button',
    ),
  ];
  await waitFor(() => {
    expect(
      view.container.querySelector('[data-streamdown="code-block"]')?.dataset
        .incomplete,
    ).toBe("true");
  });
  expect(actions().length).toBeGreaterThan(0);
  expect(actions().every((button) => button.hasAttribute("disabled"))).toBe(
    true,
  );

  await act(async () => {
    rerender([question, answer(`${partial}\n\`\`\`\n\nDone.`)], false);
  });
  await waitFor(() => {
    expect(view.container.querySelector("[data-incomplete]")).toBeNull();
    expect(view.container.textContent).toContain("Done.");
  });
  expect(actions().length).toBeGreaterThan(0);
  expect(actions().some((button) => button.hasAttribute("disabled"))).toBe(
    false,
  );
});

test("an anonymized thread renders the user's message as text, not HTML source", async () => {
  const pairs = [{ placeholder: "[PERSON_1]", original: "Jana Nováková" }];
  const { view } = renderThread(
    [
      {
        id: "question",
        parts: [
          {
            type: "text",
            content: "<p>Draft a letter to Jana Nováková about &lt;b&gt;</p>",
          },
        ],
        role: "user",
      },
      {
        id: "answer",
        metadata: { anonRestorations: { pairs } },
        parts: [{ type: "text", content: "Dear Jana Nováková," }],
        role: "assistant",
      },
    ],
    false,
  );
  const userBubble = () =>
    view.container.querySelector('[data-chat-message-id="question"]');
  await waitFor(() => {
    // The restoration pill proves the anonymized rendering path is active.
    expect(
      userBubble()?.querySelectorAll(
        '[aria-label="Sent to the model as [PERSON_1]."]',
      ),
    ).toHaveLength(1);
  });
  expect(userBubble()?.textContent).toBe(
    "Draft a letter to Jana Nováková about <b>",
  );
});
