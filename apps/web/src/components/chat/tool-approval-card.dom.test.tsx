import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { act, cleanup, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { ChatApprovalContext } = await import("./chat-approval-context");
const { ToolApprovalCard } = await import("./tool-approval-card");

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

const pendingWebSearch = {
  approval: { id: "pending-approval", needsApproval: true },
  arguments: JSON.stringify({ query: "court fees" }),
  id: "pending-tool-call",
  input: { query: "court fees" },
  name: "web_search",
  state: "approval-requested",
  type: "tool-call",
} as const;

const renderPendingCard = (
  confirmStoredApprovalGrant: () => Promise<boolean>,
) => {
  const approved: string[] = [];
  const queryClient = new QueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ChatApprovalContext
          value={{
            ...testChatApprovalContextValue,
            conversationApprovedTools: new Set(["web_search"]),
            confirmStoredApprovalGrant,
            handleApprove: (id: string) => {
              approved.push(id);
            },
          }}
        >
          <ToolApprovalCard
            isAwaitingUser
            isTurnActive={false}
            part={pendingWebSearch}
          />
        </ChatApprovalContext>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { approved, queryClient, view };
};

test("a cached grant the API no longer holds does not answer a new card", async () => {
  const { approved, queryClient } = renderPendingCard(
    async () => await Promise.resolve(false),
  );

  // Let the confirmation settle; the card must still be asking.
  await act(async () => {
    await sleep(20);
  });
  expect(approved).toEqual([]);
  queryClient.clear();
});

test("a grant the API confirms answers the card", async () => {
  const { approved, queryClient } = renderPendingCard(
    async () => await Promise.resolve(true),
  );

  await act(async () => {
    await waitFor(() => {
      expect(approved).toEqual(["pending-approval"]);
    });
  });
  queryClient.clear();
});

test("a denied approval restored as an SDK error shows only its denial status", () => {
  const queryClient = new QueryClient();
  const input = { name: "Mutual NDA", positions: [] };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ChatApprovalContext value={testChatApprovalContextValue}>
          <ToolApprovalCard
            isAwaitingUser={false}
            isTurnActive={false}
            part={{
              approval: {
                approved: false,
                id: "denied-approval",
                needsApproval: true,
              },
              arguments: JSON.stringify(input),
              id: "denied-tool-call",
              input,
              name: "save_playbook",
              output: { error: "Tool execution denied by user" },
              state: "error",
              type: "tool-call",
            }}
          />
        </ChatApprovalContext>
      </IntlProvider>
    </QueryClientProvider>,
  );

  expect(
    view.getByRole("img", { name: messages.chat.approval.denied }),
  ).toBeDefined();
  expect(
    view.container.querySelectorAll("svg.lucide-x"),
    JSON.stringify({ oracle: "chat.render.cards-match-stored" }),
  ).toHaveLength(1);
  expect(view.queryByText(messages.chat.toolCall.failed)).toBeNull();
  expect(view.queryByText("Tool execution denied by user")).toBeNull();
  queryClient.clear();
});

test("a document edit approval says what changes, never a block id", () => {
  const blockId = "707C9911";
  const input = {
    operations: [
      {
        type: "replaceBlock",
        blockId,
        text: "Either party may terminate on 60 days' notice.",
      },
      {
        type: "replaceRange",
        range: {
          type: "textRange",
          story: "main",
          blockId,
          startOffset: 31,
          endOffset: 40,
          selectedTextHash: "h2ny5yc",
        },
        replace: "60 days'",
      },
    ],
  };
  const queryClient = new QueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ChatApprovalContext value={testChatApprovalContextValue}>
          <ToolApprovalCard
            isAwaitingUser
            isTurnActive={false}
            part={{
              approval: { id: "pending-docx-edit", needsApproval: true },
              arguments: JSON.stringify(input),
              id: "pending-docx-edit-call",
              input,
              name: "suggest_changes",
              state: "approval-requested",
              type: "tool-call",
            }}
          />
        </ChatApprovalContext>
      </IntlProvider>
    </QueryClientProvider>,
  );

  const text = view.container.textContent;
  expect(text).toContain("Rewrite a paragraph");
  expect(text).toContain("Either party may terminate on 60 days' notice.");
  expect(text).toContain("Replace the selected text with “60 days'”");
  expect(text).not.toContain(blockId);
  queryClient.clear();
});
