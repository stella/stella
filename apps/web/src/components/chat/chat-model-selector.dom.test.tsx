import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type {
  ChatLocalRunReadiness,
  ChatRunTarget,
} from "@stll/api-contract/chat-run-target";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";
import { toChatThreadId } from "@/lib/chat-thread-ref";

GlobalRegistrator.register({ url: "https://app.example.test/chat/thread" });
const originalFetch = globalThis.fetch;
// Every read the test needs is seeded; anything else answers empty.
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});

const { act, cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { localRunnersOptions, modelOptionsOptions } =
  await import("@/features/chat/queries");
const benchmarks = await import("@stll/ai-catalog/benchmarks");
const { useState } = await import("react");
const { ChatComposerChips } =
  await import("@/components/chat/chat-model-selector");

afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const ORGANIZATION_ID = "org-local-run";
const LOCAL_TARGET = {
  kind: "local",
  harness: "codex",
  model: "gpt-5-codex",
  approvals: "ask",
  reasoningEffort: null,
} as const satisfies ChatRunTarget;

const READINESS: ChatLocalRunReadiness = {
  status: "enabled",
  runners: [
    {
      desktopId: "desktop-1",
      connected: true,
      lastSeenAt: "2026-11-03T10:00:00.000Z",
      linkedFolders: [],
      harnesses: [
        {
          id: "codex",
          state: "ready",
          version: "0.50.0",
          capabilities: ["approvals"],
          approvalModes: ["ask"],
          models: [
            { id: "gpt-5-codex", label: "GPT-5 Codex", reasoningEfforts: [] },
          ],
        },
      ],
    },
  ],
  maxApprovals: "full_auto",
};

const CLOUD_MODEL = {
  value: "openai::gpt-5",
  displayName: "GPT-5",
  modelId: "gpt-5",
  provider: "openai",
  iconProvider: "openai",
  defaultReasoningEffort: null,
  reasoningEfforts: null,
} as const;

const renderChips = (
  initial: ChatRunTarget,
  /** `unreadable`: reading the member's computers fails. */
  readiness: ChatLocalRunReadiness | "unreadable" = READINESS,
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (readiness !== "unreadable") {
    queryClient.setQueryData(
      localRunnersOptions(ORGANIZATION_ID).queryKey,
      readiness,
    );
  }
  queryClient.setQueryData(modelOptionsOptions(ORGANIZATION_ID).queryKey, {
    options: [CLOUD_MODEL],
    defaultValue: CLOUD_MODEL.value,
    benchmarkOptions: [],
    benchmarkMetadata: {
      benchmarkName: benchmarks.MODEL_BENCHMARK_NAME,
      licence: benchmarks.MODEL_BENCHMARK_LICENCE,
      publishDate: benchmarks.MODEL_BENCHMARK_PUBLISH_DATE,
      sourceUrl: benchmarks.MODEL_BENCHMARK_SOURCE_URL,
      typicalCallInputTokens: benchmarks.TYPICAL_CALL_INPUT_TOKENS,
      typicalCallOutputTokens: benchmarks.TYPICAL_CALL_OUTPUT_TOKENS,
    },
  });
  const chosen: ChatRunTarget[] = [];
  /** The composer's owner, reduced to holding the newest pick. */
  const Composer = () => {
    const [target, setTarget] = useState(initial);
    return (
      <ChatComposerChips
        models={{
          activeOrganizationId: ORGANIZATION_ID,
          threadRef: {
            scope: "global",
            threadId: toChatThreadId("thread-local-run"),
          },
          state: "ready",
          selectedModel: null,
          selectedReasoningEffort: null,
          selectModel: () => undefined,
          runTarget: {
            type: "choice",
            selected: target,
            select: (next) => {
              chosen.push(next);
              setTarget(next);
            },
          },
        }}
      />
    );
  };
  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <Composer />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { chosen };
};

const openMenu = async (label: string) => {
  const trigger = await screen.findByRole("button", { name: label });
  await act(async () => {
    fireEvent.click(trigger);
  });
  return await screen.findByRole("menu");
};

const closeMenu = async () => {
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
  });
};

const waitForMenuClosed = async () => {
  await waitFor(() => expect(screen.queryByRole("menu") === null).toBe(true));
};

const choose = async (menu: HTMLElement, name: string) => {
  const item = within(menu)
    .getAllByRole("menuitemradio")
    .find((candidate) =>
      candidate.textContent.replace(/^Selected/u, "").startsWith(name),
    );
  if (item === undefined) {
    throw new Error(`no ${name} choice`);
  }
  await act(async () => {
    fireEvent.click(item);
  });
};

const CLOUD_PLACE = "Runs on: Cloud";
const CODEX_PLACE = "Runs on: Your computer, Codex";
const AUTO_LABEL = messages.chat.modelSelector.autoLabel;
const SEARCH = messages.organization.aiConfig.modelIdPlaceholder;

test("the model chip names the reasoning effort once one is chosen", async () => {
  renderChips({ ...LOCAL_TARGET, reasoningEffort: "high" });
  expect(
    await screen.findByRole("button", { name: "GPT-5 Codex | High" }),
  ).toBeTruthy();
});

test("the where chip switches the place, and the model chip lists that place's models", async () => {
  const { chosen } = renderChips({ kind: "cloud" });
  expect(await screen.findByRole("button", { name: AUTO_LABEL })).toBeTruthy();

  const places = await openMenu(CLOUD_PLACE);
  expect(
    within(places).getByText(messages.chat.runOn.cloudDescription),
  ).toBeTruthy();
  expect(
    within(places).getByText(messages.chat.runOn.yourComputerDescription),
  ).toBeTruthy();
  await choose(places, "Codex");
  expect(chosen).toEqual([LOCAL_TARGET]);
  // Picking a place closes the menu.
  await waitForMenuClosed();

  // On the computer: the agent's models and none of stella's. This agent
  // marks no default, so none is called recommended.
  expect(await screen.findByRole("button", { name: CODEX_PLACE })).toBeTruthy();
  const localModels = await openMenu("GPT-5 Codex");
  expect(within(localModels).getByText("Codex models")).toBeTruthy();
  expect(
    within(localModels)
      .getAllByRole("menuitemradio")
      .map((item) => item.textContent.replace(/^Selected/u, "")),
  ).toEqual(["GPT-5 Codex"]);
  expect(within(localModels).queryByPlaceholderText(SEARCH)).toBeNull();
  expect(within(localModels).queryByText(CLOUD_MODEL.displayName)).toBeNull();
  await closeMenu();

  await choose(await openMenu(CODEX_PLACE), messages.chat.runOn.cloud);
  expect(chosen).toEqual([LOCAL_TARGET, { kind: "cloud" }]);
  await waitForMenuClosed();
  const cloudModels = await openMenu(AUTO_LABEL);
  expect(within(cloudModels).getByPlaceholderText(SEARCH)).toBeTruthy();
  expect(within(cloudModels).getByText(CLOUD_MODEL.displayName)).toBeTruthy();
});

test("the computer's agents say whether they can take a turn, and what to do when not", async () => {
  const { chosen } = renderChips(
    { kind: "cloud" },
    {
      ...READINESS,
      runners: READINESS.runners.map((runner) => ({
        ...runner,
        harnesses: [
          ...runner.harnesses,
          { id: "claude-code", state: "needs_login", version: "2.1.309" },
        ],
      })),
    },
  );
  const places = await openMenu(CLOUD_PLACE);
  const claude = within(places)
    .getAllByRole("menuitem")
    .find((item) => item.textContent.startsWith("Claude Code"));
  expect(claude?.getAttribute("aria-disabled")).toBe("true");
  expect(claude?.textContent).toContain(messages.chat.runOn.hintSignIn);
  await act(async () => {
    if (claude !== undefined) {
      fireEvent.click(claude);
    }
  });
  expect(chosen).toEqual([]);
});

test("a chat on a computer that is offline says so on the where chip", async () => {
  renderChips(LOCAL_TARGET, {
    ...READINESS,
    runners: READINESS.runners.map((runner) => ({
      ...runner,
      connected: false,
    })),
  });
  const offline = `${CODEX_PLACE}. ${messages.chat.localRun.stateOffline}`;
  const places = await openMenu(offline);
  const items = within(places).getAllByRole("menuitem");
  // Each agent says to open stella desktop, and choosing it does so.
  expect(items.map((item) => item.getAttribute("aria-disabled"))).toEqual([
    null,
    null,
  ]);
  expect(items.at(0)?.textContent).toContain(messages.chat.runOn.hintOffline);
});

test("an agent starts on the model it marks as its default, offered first", async () => {
  const { chosen } = renderChips(
    { kind: "cloud" },
    {
      ...READINESS,
      runners: READINESS.runners.map((runner) => ({
        ...runner,
        harnesses: [
          {
            id: "codex",
            state: "ready",
            version: "0.50.0",
            capabilities: ["approvals"],
            approvalModes: ["ask"],
            models: [
              { id: "gpt-5-codex", label: "GPT-5 Codex", reasoningEfforts: [] },
              {
                id: "gpt-6.1-sol",
                label: "GPT-6.1 Sol",
                isDefault: true,
                reasoningEfforts: [],
              },
            ],
          },
        ],
      })),
    },
  );
  await choose(await openMenu(CLOUD_PLACE), "Codex");
  expect(chosen).toEqual([{ ...LOCAL_TARGET, model: "gpt-6.1-sol" }]);
  await waitForMenuClosed();
  const models = await openMenu("GPT-6.1 Sol");
  expect(
    within(models)
      .getAllByRole("menuitemradio")
      .map((item) => item.textContent.replace(/^Selected/u, "")),
  ).toEqual([`${messages.chat.runOn.modelDefault}GPT-6.1 Sol`, "GPT-5 Codex"]);
});

test("a member who may not run turns on a computer sees the model chip alone", async () => {
  renderChips({ kind: "cloud" }, { status: "hidden" });
  expect(await screen.findByRole("button", { name: AUTO_LABEL })).toBeTruthy();
  expect(screen.queryByRole("button", { name: CLOUD_PLACE })).toBeNull();
});

/** Reading the member's computers answers with a server error. */
const failRunnerReads = () => {
  const served = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const { pathname } = new URL(new Request(input, init).url);
      return pathname.endsWith("/chat/local-runners")
        ? Response.json({ message: "unavailable" }, { status: 503 })
        : await served(input, init);
    },
    { preconnect: () => undefined },
  );
  return () => {
    globalThis.fetch = served;
  };
};

test("a failed read of the computers keeps the where chip, says so, and offers a retry", async () => {
  const restore = failRunnerReads();
  try {
    renderChips({ kind: "cloud" }, "unreadable");
    const places = await openMenu(CLOUD_PLACE);
    expect(
      await within(places).findByText(messages.chat.runOn.checkFailed),
    ).toBeTruthy();
    expect(
      within(places).getByRole("menuitem", { name: messages.common.retry }),
    ).toBeTruthy();
  } finally {
    restore();
  }
});

test("a chat on the computer whose read failed says so on both chips, claiming nothing else", async () => {
  const restore = failRunnerReads();
  try {
    renderChips(LOCAL_TARGET, "unreadable");
    const failed = `${CODEX_PLACE}. ${messages.chat.runOn.checkFailed}`;
    expect(await screen.findByRole("button", { name: failed })).toBeTruthy();
    const models = await openMenu("gpt-5-codex");
    expect(
      await within(models).findByText(messages.chat.runOn.checkFailed),
    ).toBeTruthy();
    expect(
      within(models).queryByText(messages.chat.localRun.stateUnavailable),
    ).toBeNull();
  } finally {
    restore();
  }
});

test("a permission pick keeps the where menu open for another choice", async () => {
  const claude = {
    kind: "local",
    harness: "claude-code",
    model: "sonnet",
    approvals: "ask",
    reasoningEffort: null,
  } as const satisfies ChatRunTarget;
  const { chosen } = renderChips(claude, {
    ...READINESS,
    runners: READINESS.runners.map((runner) => ({
      ...runner,
      harnesses: [
        ...runner.harnesses,
        {
          id: "claude-code",
          state: "ready",
          version: "2.1.309",
          capabilities: ["approvals"],
          approvalModes: ["ask", "auto"],
          models: [{ id: "sonnet", label: "Sonnet", reasoningEfforts: [] }],
        },
      ],
    })),
  });
  const places = await openMenu("Runs on: Your computer, Claude Code");
  await choose(places, "Auto");
  expect(chosen).toEqual([{ ...claude, approvals: "auto" }]);
  expect(screen.queryByRole("menu") === null).toBe(false);
});
