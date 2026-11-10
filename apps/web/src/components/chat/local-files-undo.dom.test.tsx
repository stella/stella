import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";
import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import messages from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";

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
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");

const THREAD_ID = "00000000-0000-4000-8000-000000000002";
const TURN_ID = "00000000-0000-4000-8000-000000000003";
const ANSWER = "I updated the notice in drafts/notice.md.";

const answerMessage = {
  id: "00000000-0000-4000-8000-000000000001",
  role: "assistant",
  parts: [{ type: "text", content: ANSWER }],
} satisfies ChatUIMessage;

type UndoState = "queued" | "sent" | "restored" | "refused" | "expired";

/** The server as the test sets it: the turn's undo, and how a request is answered. */
const server: {
  undo: { state: UndoState; reason: string | null } | null;
  answer: { status: number; body: unknown };
  requests: number;
} = {
  undo: null,
  answer: { status: 202, body: null },
  requests: 0,
};

const UNDO_PATH = `/v1/chat/threads/${THREAD_ID}/turns/${TURN_ID}/local-files/undo`;

const read = () => ({
  undoable: true,
  undo:
    server.undo === null
      ? null
      : {
          restoreId: "restore-1",
          state: server.undo.state,
          reason: server.undo.reason,
        },
});

const clients: InstanceType<typeof QueryClient>[] = [];
beforeEach(() => {
  server.undo = null;
  server.requests = 0;
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        const method = (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        if (url.pathname !== UNDO_PATH) {
          return Response.json({});
        }
        if (method === "POST") {
          server.requests += 1;
          return Response.json(server.answer.body, {
            status: server.answer.status,
          });
        }
        return Response.json(read());
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
});
afterEach(async () => {
  mock.restore();
  await act(async () => {
    cleanup();
    for (const client of clients) {
      client.clear();
    }
    clients.length = 0;
  });
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const renderTurn = ({
  transcript = [answerMessage],
  undoneTurns,
}: {
  transcript?: ChatUIMessage[];
  undoneTurns?: { assistantMessageId: string }[];
} = {}) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(queryClient);
  const view = render(
    <ChatThreadTestRouter>
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <AuthenticatedUserProvider
              user={{
                activeOrganizationId: "org-1",
                email: "member@example.test",
                id: "user-1",
                image: null,
                name: "Member",
                preferredName: null,
                timezoneId: "UTC",
                wordEditShortcut: null,
              }}
            >
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
                      messages={transcript}
                      newestLocalTurn={{
                        id: toSafeId<"chatTurn">(TURN_ID),
                        assistantMessageId: toSafeId<"chatMessage">(
                          answerMessage.id,
                        ),
                      }}
                      undoneTurns={undoneTurns?.map(
                        ({ assistantMessageId }) => ({
                          assistantMessageId:
                            toSafeId<"chatMessage">(assistantMessageId),
                        }),
                      )}
                      onAskUserSubmit={() => {}}
                      onCreateDocumentResolve={() => {}}
                      onOpenCreatedDocument={() => {}}
                      onResend={() => {}}
                      streamdownComponents={{
                        a: ({ children, ...props }) => (
                          <a {...props}>{children}</a>
                        ),
                      }}
                      threadRef={{
                        scope: "global",
                        threadId: toSafeId<"chatThread">(THREAD_ID),
                      }}
                    />
                  </ChatEditorProvider>
                </ChatApprovalContext>
              </ChatMattersContext>
            </AuthenticatedUserProvider>
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>
    </ChatThreadTestRouter>,
  );
  return { queryClient, view };
};

const row = (view: ReturnType<typeof render>, messageId = answerMessage.id) => {
  const actions = view.container.querySelector(
    `[data-chat-message-id="${messageId}"] [data-chat-answer-actions]`,
  );
  if (!(actions instanceof HTMLElement)) {
    throw new TypeError("Expected the answer's action row");
  }
  return actions;
};

const menuItems = () =>
  Array.from(document.querySelectorAll('[role="menuitem"]'), (item) =>
    item.textContent.trim(),
  );

const openActions = async (view: ReturnType<typeof render>) => {
  await waitFor(() => view.getByText(ANSWER));
  fireEvent.click(
    within(row(view)).getByRole("button", { name: messages.common.actions }),
  );
  await waitFor(() => {
    expect(menuItems().length).toBeGreaterThan(0);
  });
};

const askToUndo = async (view: ReturnType<typeof render>) => {
  await openActions(view);
  const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
    (element) =>
      element.textContent.trim() === messages.chat.localFilesUndo.action,
  );
  if (!(item instanceof HTMLElement)) {
    throw new TypeError("Expected the undo action");
  }
  fireEvent.click(item);
  const dialog = await waitFor(() => view.getByRole("alertdialog"));
  expect(dialog.textContent).toContain(
    messages.chat.localFilesUndo.confirmDescription,
  );
  return dialog;
};

test("the undo asks first, then shows its progress and the lasting marker", async () => {
  server.answer = {
    status: 202,
    body: {
      status: "accepted",
      undo: { restoreId: "restore-1", state: "queued", reason: null },
      reason: null,
    },
  };
  const { queryClient, view } = renderTurn();
  const dialog = await askToUndo(view);
  // Nothing is asked of the computer until the member confirms.
  expect(server.requests).toBe(0);

  server.undo = { state: "queued", reason: null };
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: messages.chat.localFilesUndo.confirm,
    }),
  );
  await waitFor(() => {
    expect(row(view).textContent).toContain(
      messages.chat.localFilesUndo.pending,
    );
  });
  expect(server.requests).toBe(1);

  // The computer answers; the next read shows the marker, and the action is
  // no longer offered.
  server.undo = { state: "restored", reason: null };
  await act(async () => {
    await queryClient.invalidateQueries();
  });
  await waitFor(() => {
    expect(row(view).textContent).toContain(
      messages.chat.localFilesUndo.restored,
    );
  });
  await openActions(view);
  expect(menuItems()).not.toContain(messages.chat.localFilesUndo.action);
});

test("a reload of an undone turn shows the marker without asking again", async () => {
  server.undo = { state: "restored", reason: null };
  const { view } = renderTurn();
  await waitFor(() => {
    expect(row(view).textContent).toContain(
      messages.chat.localFilesUndo.restored,
    );
  });
  expect(server.requests).toBe(0);
});

test("a refused request says why, in plain words", async () => {
  server.answer = {
    status: 409,
    body: { status: "refused", undo: null, reason: "desktop_offline" },
  };
  const { view } = renderTurn();
  const dialog = await askToUndo(view);
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: messages.chat.localFilesUndo.confirm,
    }),
  );
  await waitFor(() => {
    expect(row(view).textContent).toContain(
      messages.chat.localFilesUndo.refused.desktopOffline,
    );
  });
  expect(server.requests).toBe(1);
});

test("an undo the computer refused shows the computer's reason and may be asked again", async () => {
  server.undo = { state: "refused", reason: "folder_busy" };
  const { view } = renderTurn();
  await waitFor(() => {
    expect(row(view).textContent).toContain(
      messages.chat.localFilesUndo.computer.folderBusy,
    );
  });
  await openActions(view);
  expect(menuItems()).toContain(messages.chat.localFilesUndo.action);
});

test("an undone turn keeps its marker after a newer turn, also when the page loads again", async () => {
  const undoneAnswer = {
    id: "00000000-0000-4000-8000-000000000010",
    role: "assistant",
    parts: [{ type: "text", content: "I rewrote drafts/lease.md." }],
  } satisfies ChatUIMessage;
  const question = {
    id: "00000000-0000-4000-8000-000000000011",
    role: "user",
    parts: [{ type: "text", content: "Now draft the notice." }],
  } satisfies ChatUIMessage;
  // The newer turn can be undone in its turn; the older one was undone.
  const { view } = renderTurn({
    transcript: [undoneAnswer, question, answerMessage],
    undoneTurns: [{ assistantMessageId: undoneAnswer.id }],
  });
  await waitFor(() => {
    expect(row(view, undoneAnswer.id).textContent).toContain(
      messages.chat.localFilesUndo.restored,
    );
  });
  expect(row(view).textContent).not.toContain(
    messages.chat.localFilesUndo.restored,
  );
  await openActions(view);
  expect(menuItems()).toContain(messages.chat.localFilesUndo.action);
});
