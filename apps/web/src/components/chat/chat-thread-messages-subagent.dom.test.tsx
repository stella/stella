import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";
import * as v from "valibot";

import { CHAT_LOCAL_RUN_PARENT_CALL_METADATA_KEY } from "@stll/api-contract/chat-local-run-tool";
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
const { mcpConnectorsOptions } = await import("@/lib/knowledge/queries");
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

/** Where a stored call names the subagent step that made it. */
const callMetadata = (parentCallId: string | null) =>
  parentCallId === null
    ? {}
    : { metadata: { [CHAT_LOCAL_RUN_PARENT_CALL_METADATA_KEY]: parentCallId } };

type StepOptions = {
  id: string;
  name: "harness_native_tool" | "command_execution" | "mcp__docs__search";
  input: Record<string, unknown>;
  /** The subagent step that made the call; `null` on the main thread. */
  parentCallId: string | null;
  rest: { state: "complete" | "error" | "input-complete"; output?: unknown };
};

const step = ({ id, name, input, parentCallId, rest }: StepOptions) => ({
  type: "tool-call",
  id,
  name,
  arguments: JSON.stringify(input),
  input,
  ...callMetadata(parentCallId),
  ...rest,
});

const subagent = (rest: StepOptions["rest"]) =>
  step({
    id: SUBAGENT,
    name: "harness_native_tool",
    input: {
      tool: "Agent",
      detail: {
        kind: "subagent",
        description: "Check the lease",
        agentType: "Explore",
      },
    },
    parentCallId: null,
    rest,
  });

const done = { state: "complete", output: { status: "completed" } } as const;

const read = step({
  id: "run_call-read",
  name: "harness_native_tool",
  input: { tool: "Read", detail: { kind: "read", path: "drafts/lease.md" } },
  parentCallId: SUBAGENT,
  rest: done,
});

const image = step({
  id: "run_call-image",
  name: "harness_native_tool",
  input: { tool: "Read", detail: { kind: "image", path: "scans/page-1.png" } },
  parentCallId: SUBAGENT,
  rest: done,
});

/** A connected server's tool the subagent called; its input is its own. */
const connectorCall = step({
  id: "run_call-docs",
  name: "mcp__docs__search",
  input: { query: "arrears cap" },
  parentCallId: SUBAGENT,
  rest: done,
});

const removal = { command: "rm draft.md" };

const turnTree = (
  queryClient: InstanceType<typeof QueryClient>,
  parts: readonly object[],
) => (
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
                    a: ({ children, ...props }) => <a {...props}>{children}</a>,
                  }}
                />
              </ChatEditorProvider>
            </ChatApprovalContext>
          </ChatMattersContext>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>
  </ChatThreadTestRouter>
);

const renderTurn = (parts: readonly object[]) => {
  const queryClient = new QueryClient();
  // A connected server's tool decorates its row from the connector list.
  queryClient.setQueryData(
    mcpConnectorsOptions(testChatApprovalContextValue.activeOrganizationId)
      .queryKey,
    { canManageCustomConnectors: false, connectors: [], nativeTools: [] },
  );
  const view = render(turnTree(queryClient, parts));
  return {
    view,
    queryClient,
    /** The same turn, as it stands after more of it arrived. */
    show: (next: readonly object[]) => {
      view.rerender(turnTree(queryClient, next));
    },
  };
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
      ...callMetadata(SUBAGENT),
      state: "approval-requested",
      approval: { id: "approval-rm", needsApproval: true },
    },
    image,
    connectorCall,
  ]);
  await view.findByText("Check the lease");
  const inGroup = within(groupOf(view.container));
  expect(inGroup.getByText(messages.chat.toolCall.subagent)).toBeDefined();
  expect(inGroup.getByText("Explore")).toBeDefined();
  // Every step it took is counted: the one waiting on the member, and the
  // connected server's tool it called.
  expect(inGroup.getByText("4 steps")).toBeDefined();
  // The connected server's tool is a row inside, never loose on the turn.
  expect(inGroup.getByText("arrears cap")).toBeDefined();
  expect(view.getAllByText("arrears cap")).toHaveLength(1);
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

test("a group opens while a step of it is under way, folds when it settles, and then stays as the member left it", async () => {
  const lookup = (state: "complete" | "input-complete") =>
    step({
      id: "run_call-lookup",
      name: "command_execution",
      input: { command: "ls notes" },
      parentCallId: SUBAGENT,
      rest: state === "complete" ? done : { state },
    });
  // The call that started the subagent has ended; a step of it has not
  // arrived yet.
  const { view, queryClient, show } = renderTurn([subagent(done), read]);
  await view.findByText("Check the lease");
  // The group's own control comes before the controls of the rows inside.
  const toggle = () =>
    within(groupOf(view.container)).getAllByRole("button").at(0) ??
    panic("the group has no control to open it");
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  await act(async () => {
    show([subagent(done), read, lookup("input-complete")]);
  });
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  await act(async () => {
    show([subagent(done), read, lookup("complete")]);
  });
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  await act(async () => {
    fireEvent.click(toggle());
  });
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  await act(async () => {
    show([subagent(done), read, lookup("complete"), image]);
  });
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  queryClient.clear();
});

test("a subagent its turn cut off reads as stopped, and a step without its subagent stays on the turn", async () => {
  const { view, queryClient } = renderTurn([
    // As a turn that ended first leaves a call: an error, said interrupted.
    subagent({ state: "error", output: { status: "interrupted" } }),
    step({
      id: "run_call-orphan",
      name: "command_execution",
      input: { command: "ls notes" },
      parentCallId: "run_call-missing",
      rest: done,
    }),
  ]);
  await view.findByText("Check the lease");
  const inGroup = within(groupOf(view.container));
  expect(inGroup.getByText(messages.chat.stopped)).toBeDefined();
  expect(inGroup.queryByText("ls notes")).toBeNull();
  expect(view.getByText("ls notes")).toBeDefined();
  queryClient.clear();
});
