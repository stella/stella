import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";
import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import messages from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { act } = await import("react");
const { cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
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
  await unregisterDomEnvironment();
});

const ANSWER = "The lease ends on 31 March.";

const renderAnswer = () => {
  const queryClient = new QueryClient();
  queryClients.push(queryClient);
  const message = {
    id: "00000000-0000-4000-8000-000000000001",
    role: "assistant",
    parts: [{ type: "text", content: ANSWER }],
  } satisfies ChatUIMessage;
  return render(
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
                  messages={[message]}
                  onAskUserSubmit={() => {}}
                  onCreateDocumentResolve={() => {}}
                  onOpenCreatedDocument={() => {}}
                  onResend={() => {}}
                  streamdownComponents={{
                    a: ({ children, ...props }) => <a {...props}>{children}</a>,
                  }}
                  threadRef={{
                    scope: "global",
                    threadId: toSafeId<"chatThread">(
                      "00000000-0000-4000-8000-000000000002",
                    ),
                  }}
                />
              </ChatEditorProvider>
            </ChatApprovalContext>
          </ChatMattersContext>
        </IntlProvider>
      </QueryClientProvider>
    </ChatThreadTestRouter>,
  );
};

/** The items of the open popup with this slot, by their visible text. */
const popupItems = (slot: string) => {
  const popup = document.querySelector(`[data-slot="${slot}"]`);
  return popup === null
    ? []
    : Array.from(popup.querySelectorAll('[role="menuitem"]'), (item) =>
        item.textContent.trim(),
      );
};

test("right-clicking the answer opens what its … button opens, item by item", async () => {
  const view = renderAnswer();
  const body = await waitFor(() => view.getByText(ANSWER));

  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    button: 2,
    cancelable: true,
    clientX: 20,
    clientY: 20,
  });
  act(() => {
    body.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
  await waitFor(() => {
    expect(popupItems("entity-actions-context-popup").length).toBeGreaterThan(
      0,
    );
  });
  const fromRightClick = popupItems("entity-actions-context-popup");

  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
  });
  await waitFor(() => {
    expect(popupItems("entity-actions-context-popup")).toEqual([]);
  });

  const row = view.container.querySelector("[data-chat-answer-actions]");
  if (!(row instanceof HTMLElement)) {
    throw new Error("Expected the answer's action row");
  }
  fireEvent.click(
    within(row).getByRole("button", { name: messages.common.actions }),
  );
  await waitFor(() => {
    expect(popupItems("entity-actions-button-popup").length).toBeGreaterThan(0);
  });
  const fromButton = popupItems("entity-actions-button-popup");

  expect(fromButton).toEqual([
    messages.chat.forkFromHere,
    messages.chat.forkInSidePanel,
    messages.common.export.title,
  ]);
  expect(fromRightClick).toEqual(fromButton);
});

test("Shift + right-click on the answer keeps the native menu", async () => {
  const view = renderAnswer();
  const body = await waitFor(() => view.getByText(ANSWER));
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    button: 2,
    cancelable: true,
    shiftKey: true,
  });
  act(() => {
    body.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(false);
  await act(async () => {});
  expect(popupItems("entity-actions-context-popup")).toEqual([]);
});

test("right-clicking a gap between the answer's parts opens its actions", async () => {
  const view = renderAnswer();
  await waitFor(() => view.getByText(ANSWER));
  // A right-click in the gap between flex children lands on the answer box:
  // the message's own content box, directly inside the actions boundary.
  const message = view.container.querySelector("[data-chat-message-id]");
  const box = message?.querySelector(
    ':scope > [data-slot="entity-actions"] > div',
  );
  if (!(box instanceof HTMLElement)) {
    throw new Error("Expected the answer box directly inside its actions");
  }
  expect(box.children.length).toBeGreaterThan(1);
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    button: 2,
    cancelable: true,
    clientX: 20,
    clientY: 40,
  });
  act(() => {
    box.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
  await waitFor(() => {
    expect(popupItems("entity-actions-context-popup")).toEqual([
      messages.chat.forkFromHere,
      messages.chat.forkInSidePanel,
      messages.common.export.title,
    ]);
  });
});
