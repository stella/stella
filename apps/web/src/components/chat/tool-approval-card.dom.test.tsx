import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { cleanup, render } = await import("@testing-library/react");
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
