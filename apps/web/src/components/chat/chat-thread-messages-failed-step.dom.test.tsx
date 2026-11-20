import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { createTestState } from "@stll/test-state";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";
import {
  type PersistedChatMessage,
  projectCanonicalChatUIMessages,
} from "@/components/chat/chat-ui-tools";

GlobalRegistrator.register({ url: "https://app.example.test/chat/thread" });

const state = createTestState({ file: import.meta.path, config: {} });
state.setEnvIfAbsent("VITE_API_URL", "https://api.example.test");
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async () => await Promise.resolve(Response.json(null)),
  { preconnect: originalFetch.preconnect },
);

const { act, cleanup, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
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

afterEach(async () => {
  await act(async () => cleanup());
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const FAILED_READ = {
  arguments: JSON.stringify({ section: "11.2" }),
  id: "tool-call-section",
  input: { section: "11.2" },
  name: "read_section",
  output: { error: "Section 11.2 was renumbered in this version." },
  state: "complete",
  type: "tool-call",
} satisfies PersistedChatMessage["parts"][number];

const ANSWER = {
  content: "The cap is 30% of the purchase price.",
  type: "text",
} satisfies PersistedChatMessage["parts"][number];

const renderTurn = (parts: PersistedChatMessage["parts"]) => {
  const queryClient = new QueryClient();
  const view = render(
    <ChatThreadTestRouter>
      <QueryClientProvider client={queryClient}>
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
                    messages={projectCanonicalChatUIMessages([
                      { id: "message-turn", parts, role: "assistant" },
                    ])}
                    onAskUserSubmit={() => {}}
                    onCreateDocumentResolve={() => {}}
                    onOpenCreatedDocument={() => {}}
                    showToolCalls
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
  return { queryClient, view };
};

test("a failed step the turn answered past reads as retried, not as broken", async () => {
  const { queryClient, view } = renderTurn([FAILED_READ, ANSWER]);

  await view.findByText(messages.chat.toolCall.retried);
  expect(view.queryByText(messages.chat.toolCall.failed)).toBeNull();
  expect(view.queryByText(messages.chat.answerNotFinished)).toBeNull();
  expect(view.container.innerHTML.includes("bg-destructive")).toBe(false);
  queryClient.clear();
});

test("a turn that ended at a failed step says so once, under its calm steps", async () => {
  const { queryClient, view } = renderTurn([FAILED_READ]);

  // One muted line beside Retry says the answer did not finish; the step
  // names its failure through its mark alone, in the step colours.
  const line = await view.findByText(messages.chat.answerNotFinished);
  expect(line.className.includes("text-muted-foreground")).toBe(true);
  expect(
    view.getByRole("img", { name: messages.chat.toolCall.failed }),
  ).toBeDefined();
  expect(view.queryByText(messages.chat.toolCall.failed)).toBeNull();
  expect(view.queryByText(messages.chat.toolCall.retried)).toBeNull();
  expect(view.container.innerHTML.includes("bg-destructive")).toBe(false);
  queryClient.clear();
});
