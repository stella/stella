import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";
import * as v from "valibot";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";
import type {
  ChatUIMessage,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";

GlobalRegistrator.register({ url: "https://app.example.test/chat/thread" });

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async () => await Promise.resolve(Response.json(null)),
  { preconnect: originalFetch.preconnect },
);

const { act, cleanup, fireEvent, render, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { ChatApprovalContext } =
  await import("@/components/chat/chat-approval-context");
const { ChatMattersContext } =
  await import("@/components/chat/chat-matters-context");
const { ChatEditorProvider } =
  await import("@/components/chat-editor-provider");
const { ChatThreadMessages } =
  await import("@/components/chat/chat-thread-messages");
const { isCanonicalChatUIMessage } =
  await import("@/components/chat/chat-ui-tools");

afterEach(async () => {
  await act(async () => cleanup());
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

/**
 * A message as the API returns one. Its type names stella's own tools; a
 * coding agent's steps reach the chat as JSON and pass the same check.
 */
const storedMessageSchema = v.custom<PersistedChatMessage>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "parts" in value &&
    Array.isArray(value.parts),
);

/** A stored turn of a local run, checked as the chat checks one it loads. */
const turnOf = (parts: readonly object[]): ChatUIMessage => {
  const message = v.parse(storedMessageSchema, {
    id: "message-1",
    parts,
    role: "assistant",
  });
  return isCanonicalChatUIMessage(message)
    ? message
    : panic("the fixture is not a turn the chat shows");
};

const SUBAGENT = "run_call-agent";

const step = (
  id: string,
  name: "harness_native_tool" | "command_execution",
  input: Record<string, unknown>,
  rest: { state: "complete" | "error" | "input-complete"; output?: unknown },
) => ({
  type: "tool-call",
  id,
  name,
  arguments: JSON.stringify(input),
  input,
  ...rest,
});

const subagent = (rest: Parameters<typeof step>[3]) =>
  step(
    SUBAGENT,
    "harness_native_tool",
    {
      tool: "Agent",
      detail: {
        kind: "subagent",
        description: "Check the lease",
        agentType: "Explore",
      },
    },
    rest,
  );

const done = { state: "complete", output: { status: "completed" } } as const;

const read = step(
  "run_call-read",
  "harness_native_tool",
  {
    tool: "Read",
    detail: { kind: "read", path: "drafts/lease.md" },
    parentCallId: SUBAGENT,
  },
  done,
);

const image = step(
  "run_call-image",
  "harness_native_tool",
  {
    tool: "Read",
    detail: { kind: "image", path: "scans/page-1.png" },
    parentCallId: SUBAGENT,
  },
  done,
);

const removal = { command: "rm draft.md", parentCallId: SUBAGENT };

const renderTurn = (parts: readonly object[]) => {
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
                    messages={[turnOf(parts)]}
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
  return { view, queryClient };
};

/** The turn's one subagent group. */
const groupOf = (container: HTMLElement): HTMLElement => {
  const groups = [
    ...container.querySelectorAll<HTMLElement>(
      '[data-slot="local-run-subagent"]',
    ),
  ];
  expect(groups).toHaveLength(1);
  const group = groups.at(0);
  if (group === undefined) {
    throw new Error("the turn drew no subagent group");
  }
  return group;
};

test("a subagent's steps show inside its group, and one waiting on the member shows without opening it", async () => {
  const { view, queryClient } = renderTurn([
    subagent({ state: "input-complete" }),
    read,
    {
      type: "tool-call",
      id: "run_call-rm",
      name: "command_execution",
      arguments: JSON.stringify(removal),
      input: removal,
      state: "approval-requested",
      approval: { id: "approval-rm", needsApproval: true },
    },
    image,
  ]);
  await view.findByText("Check the lease");
  const inGroup = within(groupOf(view.container));
  expect(inGroup.getByText(messages.chat.toolCall.subagent)).toBeDefined();
  expect(inGroup.getByText("Explore")).toBeDefined();
  // Every step it took is counted, the one waiting on the member included.
  expect(inGroup.getByText("3 steps")).toBeDefined();
  expect(
    inGroup.getByText(messages.chat.turnStatus.waitingForApproval),
  ).toBeDefined();
  // Open while it works: the steps it took are rows inside, the image among
  // them although an approval card sits between it and the rest.
  expect(inGroup.getByText("drafts/lease.md")).toBeDefined();
  expect(inGroup.getByText(messages.chat.toolCall.viewImage)).toBeDefined();
  expect(inGroup.getByText("scans/page-1.png")).toBeDefined();
  // The step that needs the member is on the turn, outside the group, and
  // no step is drawn twice or left in an empty run of its own.
  expect(inGroup.queryByText("rm draft.md")).toBeNull();
  expect(view.getAllByText("rm draft.md").length).toBeGreaterThan(0);
  expect(view.getAllByText("scans/page-1.png")).toHaveLength(1);
  expect(view.getAllByText("drafts/lease.md")).toHaveLength(1);
  expect(
    view.container.querySelectorAll('[data-slot="chat-step-list"]'),
  ).toHaveLength(1);
  queryClient.clear();
});

test("a finished subagent folds its steps behind its row, and opens on a click", async () => {
  const { view, queryClient } = renderTurn([subagent(done), read, image]);
  await view.findByText("Check the lease");
  const inGroup = within(groupOf(view.container));
  expect(inGroup.getByText("2 steps")).toBeDefined();
  expect(
    inGroup.queryByText(messages.chat.turnStatus.waitingForApproval),
  ).toBeNull();
  const toggle = inGroup.getByRole("button", { expanded: false });
  await act(async () => {
    fireEvent.click(toggle);
  });
  expect(inGroup.getByRole("button", { expanded: true })).toBe(toggle);
  expect(inGroup.getByText("drafts/lease.md")).toBeDefined();
  queryClient.clear();
});

test("a subagent its turn cut off reads as stopped, and a step without its subagent stays on the turn", async () => {
  const { view, queryClient } = renderTurn([
    // As a turn that ended first leaves a call: an error, said interrupted.
    subagent({ state: "error", output: { status: "interrupted" } }),
    step(
      "run_call-orphan",
      "command_execution",
      { command: "ls notes", parentCallId: "run_call-missing" },
      done,
    ),
  ]);
  await view.findByText("Check the lease");
  const inGroup = within(groupOf(view.container));
  expect(inGroup.getByText(messages.chat.stopped)).toBeDefined();
  expect(inGroup.queryByText("ls notes")).toBeNull();
  expect(view.getByText("ls notes")).toBeDefined();
  queryClient.clear();
});
