import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";
import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import messages from "@/i18n/langs/en.json";
import type { ChatSourceDocument } from "@/lib/api-contract";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });
const previousApiUrl = process.env["VITE_API_URL"];
process.env["VITE_API_URL"] ??= "https://api.example.test";
const { act } = await import("react");
const { cleanup, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
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
  await unregisterDomEnvironment();
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
          <FormattingProvider locale="en" timeZone="UTC">
            <ChatMattersContext
              value={{ createDocumentMattersView: { type: "empty" } }}
            >
              <ChatApprovalContext value={testChatApprovalContextValue}>
                <ChatEditorProvider>{children}</ChatEditorProvider>
              </ChatApprovalContext>
            </ChatMattersContext>
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>
    </ChatThreadTestRouter>,
  );
};

const renderMessage = (message: ChatUIMessage) =>
  renderWithProviders(
    <ChatThreadMessages
      activitySession={{ reportedUnknownActivityTypes: new Set<string>() }}
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

const renderAssistant = (sourceDocuments?: readonly ChatSourceDocument[]) =>
  renderMessage({
    id: "assistant-answer",
    role: "assistant",
    parts: [{ type: "text", content: "Answer text" }],
    ...(sourceDocuments === undefined
      ? {}
      : { metadata: { sourceDocuments: [...sourceDocuments] } }),
  });

/** What each direct child of the footer row is. */
const footerItems = (footer: Element) =>
  [...footer.children].map((child) => {
    if (!(child instanceof HTMLElement)) {
      return "unexpected";
    }
    if (Object.hasOwn(child.dataset, "chatAnswerActions")) {
      return "actions";
    }
    if (Object.hasOwn(child.dataset, "chatTurnDuration")) {
      return "duration";
    }
    if (Object.hasOwn(child.dataset, "chatAnswerCitations")) {
      return "citations";
    }
    return "unexpected";
  });

test("assistant footer places an unlinked source after the actions", async () => {
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
  expect(footerItems(footer)).toEqual(["actions", "citations"]);
  const citations = footer.querySelector("[data-chat-answer-citations]");
  expect(citations?.classList.contains("contents")).toBe(true);
  expect(
    view
      .getByText("Pl.ÚS 38/06")
      .closest("button")
      ?.classList.contains("max-w-full"),
  ).toBe(true);
  expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("assistant footer holds the turn's duration and consulted sources in the actions' row", async () => {
  const view = renderMessage({
    id: "assistant-answer",
    role: "assistant",
    parts: [{ type: "text", content: "Answer text" }],
    metadata: {
      sourceDocuments: [
        {
          entityId: "decision-1",
          kind: "decision",
          mimeType: null,
          title: "Pl.ÚS 38/06",
          workspaceId: "workspace-1",
        },
      ],
      turnTiming: { status: "finished", durationMs: 19_000 },
    },
  });
  await act(async () => {});
  const footer = view.container.querySelector("[data-chat-answer-footer]");
  if (footer === null) {
    throw new Error("Expected an assistant answer footer");
  }
  expect(footerItems(footer)).toEqual(["actions", "duration", "citations"]);
  expect(footer.textContent).toContain("Worked for 19s");

  // The disclosure's root leaves its trigger in the row; a wrapper with a box
  // would take the row's items and break the line.
  const trigger = view.getByRole("button", { name: "Also consulted (1)" });
  const citations = footer.querySelector("[data-chat-answer-citations]");
  expect(citations?.classList.contains("contents")).toBe(true);
  expect(
    citations
      ?.querySelector('[data-slot="collapsible"]')
      ?.classList.contains("contents"),
  ).toBe(true);
  // The divider travels with the trigger, so it never ends a wrapped line.
  expect(
    trigger.parentElement?.querySelector(
      "[data-chat-answer-citations-divider]",
    ),
  ).toBeTruthy();
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
