import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";
import * as v from "valibot";

import fixtures from "@stll/api-contract/chat-local-run-steps.fixtures";
import { CHAT_LOCAL_RUN_PARENT_CALL_METADATA_KEY } from "@stll/api-contract/chat-local-run-tool";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";
import type {
  ChatUIMessage,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import type {
  LocalRunStepImageView,
  LocalRunStepOutputView,
} from "@/features/chat/local-run-step-output.logic";

GlobalRegistrator.register({ url: "https://app.example.test/chat/thread" });

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async () => await Promise.resolve(Response.json(null)),
  { preconnect: originalFetch.preconnect },
);

const { act, cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
// Load the real lazy renderer before assertions use its parsed Markdown.
await import("@/components/ai-elements/message-response");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { mcpConnectorsOptions } = await import("@/lib/knowledge/queries");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { chatKeys } = await import("@/features/chat/chat-query-contract");
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
            <AuthenticatedUserProvider user={MEMBER}>
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
            </AuthenticatedUserProvider>
          </ChatMattersContext>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>
  </ChatThreadTestRouter>
);

/** The member whose computer ran the turn. */
const MEMBER = {
  activeOrganizationId: testChatApprovalContextValue.activeOrganizationId,
  id: "user-fixture",
  email: "member@example.test",
  image: null,
  name: "Fixture member",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};

const keptKey = (callId: string) => ({
  activeOrganizationId: MEMBER.activeOrganizationId,
  userId: MEMBER.id,
  callId,
});

type RenderOptions = {
  /**
   * What the computer answers for the subagent's conversation, as a read of
   * it left the cache; nothing kept unless a test says otherwise. A read
   * the desktop answered holds, so no test reaches for the computer.
   */
  conversation?: LocalRunStepOutputView;
  /** What the computer answers for the viewed image. */
  image?: LocalRunStepImageView;
};

const renderTurn = (
  parts: readonly object[],
  {
    conversation = { status: "not-kept" },
    image: viewed = { status: "not-kept" },
  }: RenderOptions = {},
) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    chatKeys.localRunStepOutput(keptKey(SUBAGENT)),
    conversation,
  );
  queryClient.setQueryData(
    chatKeys.localRunStepImage(keptKey("run_call-image")),
    viewed,
  );
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

const conversationOf = (...entries: (readonly [string, string])[]) => {
  const text = entries
    .map(([role, said]) => `${JSON.stringify({ role, text: said })}\n`)
    .join("");
  const bytes = new TextEncoder().encode(text).length;
  return {
    status: "shown",
    text,
    keptBytes: bytes,
    totalBytes: bytes,
  } as const;
};

test("opening a finished subagent shows what it was told, wrote and reported, read from the computer", async () => {
  const { view, queryClient } = renderTurn([subagent(done), read], {
    conversation: conversationOf(
      ["prompt", "List every clause on arrears."],
      // Kept ahead of what it wrote, shown after it.
      ["report", "Clause 4 caps arrears."],
      [
        "message",
        "**Reading** the lease.\n\n![chart](https://tracker.example/pixel.png)\n\n<script>window.stolen = 1</script>",
      ],
    ),
  });
  await view.findByText("Check the lease");
  const inGroup = within(groupOf(view.container));
  // Folded, the group has read nothing from the computer.
  expect(inGroup.queryByText("List every clause on arrears.")).toBeNull();
  await act(async () => {
    fireEvent.click(inGroup.getByRole("button", { expanded: false }));
  });
  const region = inGroup.getByRole("region", {
    name: messages.chat.toolCall.localOutput.conversation,
  });
  // Formatted as the answer is: the emphasis is drawn, not its markers.
  const emphasis = await waitFor(() => {
    const strong = region.querySelector('[data-streamdown="strong"]');
    if (strong === null) {
      throw new Error("The conversation is not formatted yet");
    }
    return strong;
  });
  expect(emphasis.textContent).toBe("Reading");
  // The entries themselves, not the lists a formatted entry may hold.
  const [prompt, message, report] = [
    ...(region.querySelector("ol")?.children ?? []),
  ].map((item) => item.textContent);
  expect(prompt).toBe(
    `${messages.chat.toolCall.localOutput.conversationPrompt}List every clause on arrears.`,
  );
  expect(message).toContain("Reading the lease.");
  expect(message).not.toContain("**");
  expect(report).toBe(
    `${messages.chat.toolCall.localOutput.conversationReport}Clause 4 caps arrears.`,
  );
  // A model wrote it: opening it requests nothing it names and runs nothing.
  expect(region.querySelector("img")).toBeNull();
  expect(region.querySelector("script")).toBeNull();
  expect(message).toContain("chart");
  // The steps it took still show beside its conversation.
  expect(inGroup.getByText("drafts/lease.md")).toBeDefined();
  queryClient.clear();
});

test("a subagent with nothing kept on this computer says so, and one that took no steps still opens", async () => {
  const { view, queryClient } = renderTurn([subagent(done)]);
  await view.findByText("Check the lease");
  const inGroup = within(groupOf(view.container));
  await act(async () => {
    fireEvent.click(inGroup.getByRole("button", { expanded: false }));
  });
  expect(
    inGroup.getByText(messages.chat.toolCall.localOutput.notKept),
  ).toBeDefined();
  queryClient.clear();
});

test("a subagent still at work has no conversation to open yet", async () => {
  const { view, queryClient } = renderTurn([
    subagent({ state: "input-complete" }),
  ]);
  await view.findByText("Check the lease");
  // No steps and no settled call: the row is only its header.
  expect(within(groupOf(view.container)).queryAllByRole("button")).toEqual([]);
  queryClient.clear();
});

const PNG_SRC = "data:image/png;base64,iVBORw0KGgo=";

const openImageRow = async (view: ReturnType<typeof render>) => {
  const row =
    view.getByText("scans/page-1.png").closest("button") ??
    panic("the image step has no row to open");
  await act(async () => {
    fireEvent.click(row);
  });
};

test("opening an image step shows the image read from the computer, named by its file", async () => {
  const { view, queryClient } = renderTurn([image], {
    image: { status: "shown", type: "image/png", src: PNG_SRC },
  });
  await view.findByText("scans/page-1.png");
  expect(view.queryByRole("img", { name: "scans/page-1.png" })).toBeNull();
  await openImageRow(view);
  expect(
    view.getByRole("img", { name: "scans/page-1.png" }).getAttribute("src"),
  ).toBe(PNG_SRC);
  queryClient.clear();
});

test("an image the computer does not keep says why instead of showing one", async () => {
  const { view, queryClient } = renderTurn([image], {
    image: { status: "too-large", totalBytes: 3 * 1024 * 1024 },
  });
  await view.findByText("scans/page-1.png");
  await openImageRow(view);
  expect(view.queryByRole("img", { name: "scans/page-1.png" })).toBeNull();
  // Both sizes are named: the image's, and the most the computer keeps.
  expect(
    view.getByText(/^This image is \S+ MB\. Images over \S+ MB are not kept/u),
  ).toBeDefined();
  queryClient.clear();
});

test("a stored turn groups by the link in each call's metadata, as the phone groups it, and never by a step's input", async () => {
  // The fixture the contract's and the phone's tests read too.
  const { view, queryClient } = renderTurn(fixtures.parts);
  await view.findByText("Check the lease");
  const inGroup = within(groupOf(view.container));
  expect(
    inGroup.getByText(`${String(fixtures.stepsOfSubagent.length)} steps`),
  ).toBeDefined();
  await act(async () => {
    fireEvent.click(inGroup.getByRole("button", { expanded: false }));
  });
  expect(inGroup.getByText("rg arrears")).toBeDefined();
  expect(inGroup.getByText("arrears cap")).toBeDefined();
  // A link only in a step's input names nothing: the step is on the turn.
  expect(inGroup.queryByText("ls drafts")).toBeNull();
  expect(view.getByText("ls drafts")).toBeDefined();
  queryClient.clear();
});
