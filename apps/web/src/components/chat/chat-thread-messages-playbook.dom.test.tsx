import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";

GlobalRegistrator.register({ url: "https://app.example.test/chat/thread" });

const previousApiUrl = process.env["VITE_API_URL"];
process.env["VITE_API_URL"] = previousApiUrl ?? "https://api.example.test";
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async () => await Promise.resolve(Response.json(null)),
  { preconnect: originalFetch.preconnect },
);

const { act, cleanup, fireEvent, render } =
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

afterEach(async () => {
  await act(async () => cleanup());
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (previousApiUrl === undefined) {
    delete process.env["VITE_API_URL"];
  } else {
    process.env["VITE_API_URL"] = previousApiUrl;
  }
  await GlobalRegistrator.unregister();
});

test("opens the playbook an approved save wrote", async () => {
  const opened: string[] = [];
  const input = {
    name: "Mutual NDA",
    positions: [{ mode: "graded", issue: "Confidentiality term" }],
  };
  const queryClient = new QueryClient();
  const view = render(
    <ChatThreadTestRouter>
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ChatMattersContext
            value={{ createDocumentMattersView: { type: "empty" } }}
          >
            <ChatApprovalContext value={testChatApprovalContextValue}>
              <ChatEditorProvider>
                <ChatThreadMessages
                  approvalPendingMessageId={null}
                  messages={[
                    {
                      id: "message-save",
                      parts: [
                        {
                          approval: {
                            approved: true,
                            id: "approval-1",
                            needsApproval: true,
                          },
                          arguments: JSON.stringify(input),
                          id: "tool-call-save",
                          input,
                          name: "save_playbook",
                          output: { playbookId: "playbook-1" },
                          state: "complete",
                          type: "tool-call",
                        },
                      ],
                      role: "assistant",
                    },
                  ]}
                  onAskUserSubmit={() => {}}
                  onCreateDocumentResolve={() => {}}
                  onOpenCreatedDocument={() => {}}
                  onOpenPlaybook={(playbookId) => {
                    opened.push(playbookId);
                  }}
                  streamdownComponents={{
                    a: ({ children, ...props }) => <a {...props}>{children}</a>,
                  }}
                />
              </ChatEditorProvider>
            </ChatApprovalContext>
          </ChatMattersContext>
        </IntlProvider>
      </QueryClientProvider>
    </ChatThreadTestRouter>,
  );
  const openButton = await view.findByRole("button", {
    name: messages.knowledge.playbooks.openInPane,
  });
  fireEvent.click(openButton);
  expect(opened).toEqual(["playbook-1"]);
  queryClient.clear();
});
