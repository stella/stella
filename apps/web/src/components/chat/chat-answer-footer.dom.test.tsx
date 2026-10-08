import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import messages from "@/i18n/langs/en.json";
import type { ChatSourceDocument } from "@/lib/api-contract";

GlobalRegistrator.register({ url: "https://app.example.test" });
const previousApiUrl = process.env["VITE_API_URL"];
process.env["VITE_API_URL"] ??= "https://api.example.test";
const { act } = await import("react");
const { cleanup, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { ChatApprovalContext } =
  await import("@/components/chat/chat-approval-context");
const { ChatEditorProvider } =
  await import("@/components/chat-editor-provider");
const { ChatMattersContext } =
  await import("@/components/chat/chat-matters-context");
const { ChatThreadMessages } =
  await import("@/components/chat/chat-thread-messages");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");

const queryClients: InstanceType<typeof QueryClient>[] = [];
afterEach(async () => {
  await act(async () => {
    cleanup();
    for (const queryClient of queryClients) {
      queryClient.clear();
    }
    queryClients.length = 0;
  });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
  if (previousApiUrl === undefined) {
    delete process.env["VITE_API_URL"];
  } else {
    process.env["VITE_API_URL"] = previousApiUrl;
  }
});

const renderWithProviders = (children: ReactNode) => {
  const queryClient = new QueryClient();
  queryClients.push(queryClient);
  return render(
    <ChatThreadTestRouter>
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ChatMattersContext
            value={{ createDocumentMattersView: { type: "empty" } }}
          >
            <ChatApprovalContext
              value={{
                activeOrganizationId: "test-active-organization",
                alwaysApprovedTools: new Set(),
                conversationApprovedTools: new Set(),
                handleAllowInConversation: () => {},
                handleAlwaysAllow: () => {},
                handleApprove: () => {},
                handleDeny: () => {},
                handleRequestSecret: async () => ({
                  status: "declined",
                  target: { type: "mcp-connector", connectorSlug: "test" },
                }),
                secretAvailabilityKey: "test-thread",
                checkSavedSecretAvailability: async () => false,
              }}
            >
              <ChatEditorProvider>{children}</ChatEditorProvider>
            </ChatApprovalContext>
          </ChatMattersContext>
        </IntlProvider>
      </QueryClientProvider>
    </ChatThreadTestRouter>,
  );
};

const renderAssistant = (sourceDocuments?: readonly ChatSourceDocument[]) => {
  const message = {
    id: "assistant-answer",
    role: "assistant",
    parts: [{ type: "text", content: "Answer text" }],
    ...(sourceDocuments === undefined
      ? {}
      : { metadata: { sourceDocuments: [...sourceDocuments] } }),
  } satisfies ChatUIMessage;

  return renderWithProviders(
    <ChatThreadMessages
      approvalPendingMessageId={null}
      messages={[message]}
      onResend={() => {}}
      onAskUserSubmit={() => {}}
      onCreateDocumentResolve={() => {}}
      onOpenCreatedDocument={() => {}}
      streamdownComponents={{
        a: ({ children, ...props }) => <a {...props}>{children}</a>,
      }}
    />,
  );
};

test("assistant footer places actions before a divider and wrapping citations", async () => {
  const view = renderAssistant([
    {
      entityId: "decision-1",
      kind: "decision",
      mimeType: null,
      title: "Pl.ÚS 38/06",
      workspaceId: "workspace-1",
    },
  ]);
  await act(async () => {});
  const footer = view.container.querySelector("[data-chat-answer-footer]");
  if (footer === null) {
    throw new Error("Expected an assistant answer footer");
  }
  expect(footer.classList.contains("flex-wrap")).toBe(true);
  expect(
    [...footer.children].map((child) => {
      if (!(child instanceof HTMLElement)) {
        return "unexpected";
      }
      if (Object.hasOwn(child.dataset, "chatAnswerActions")) {
        return "actions";
      }
      if (Object.hasOwn(child.dataset, "chatAnswerCitationsDivider")) {
        return "divider";
      }
      if (Object.hasOwn(child.dataset, "chatAnswerCitations")) {
        return "citations";
      }
      return "unexpected";
    }),
  ).toEqual(["actions", "divider", "citations"]);
  const citations = footer.querySelector("[data-chat-answer-citations]");
  expect(citations?.classList.contains("contents")).toBe(true);
  expect(
    citations?.querySelector("button")?.classList.contains("max-w-full"),
  ).toBe(true);
  expect(citations?.textContent).toContain("Pl.ÚS 38/06");
  expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("assistant footer omits the divider when there are no citations", async () => {
  const view = renderAssistant();
  await act(async () => {});
  expect(
    view.container.querySelector("[data-chat-answer-citations-divider]"),
  ).toBeNull();
  expect(
    view.container.querySelector("[data-chat-answer-citations]"),
  ).toBeNull();
});
