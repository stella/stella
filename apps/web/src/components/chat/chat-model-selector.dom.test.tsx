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

const { act, cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { localRunnersOptions, modelOptionsOptions } =
  await import("@/features/chat/queries");
const benchmarks = await import("@stll/ai-catalog/benchmarks");
const { ChatModelSelector } =
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
} as const satisfies ChatRunTarget;

const READINESS: ChatLocalRunReadiness = {
  status: "enabled",
  runners: [
    {
      desktopId: "desktop-1",
      connected: true,
      lastSeenAt: "2026-11-03T10:00:00.000Z",
      harnesses: [
        {
          id: "codex",
          state: "ready",
          version: "0.50.0",
          capabilities: ["approvals"],
          models: [{ id: "gpt-5-codex", label: "GPT-5 Codex" }],
        },
      ],
    },
  ],
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

const renderSelector = (selected: ChatRunTarget) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    localRunnersOptions(ORGANIZATION_ID).queryKey,
    READINESS,
  );
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
  const tree = (target: ChatRunTarget) => (
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <ChatModelSelector
            models={{
              activeOrganizationId: ORGANIZATION_ID,
              threadRef: {
                scope: "global",
                threadId: toChatThreadId("thread-local-run"),
              },
              selectedModel: null,
              selectedReasoningEffort: null,
              selectModel: () => undefined,
              runTarget: {
                selected: target,
                select: (next) => {
                  chosen.push(next);
                },
              },
            }}
          />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>
  );
  const view = render(tree(selected));
  return {
    chosen,
    rerender: (target: ChatRunTarget) => view.rerender(tree(target)),
  };
};

const openMenu = async (label: string) => {
  const trigger = screen.getByRole("button", { name: label });
  await act(async () => {
    fireEvent.click(trigger);
  });
};

const LOCAL_LABEL = "Codex · GPT-5 Codex";
const AUTO_LABEL = messages.chat.modelSelector.autoLabel;

test("a thread on the member's computer names its harness and model, not Auto", () => {
  renderSelector(LOCAL_TARGET);
  expect(screen.getByRole("button", { name: LOCAL_LABEL })).toBeTruthy();
  expect(screen.queryByRole("button", { name: AUTO_LABEL })).toBeNull();
});

test("a thread on the member's computer is not offered stella's models, only the way back", async () => {
  const { chosen } = renderSelector(LOCAL_TARGET);
  await openMenu(LOCAL_LABEL);

  expect(await screen.findByText(messages.chat.localRun.runOn)).toBeTruthy();
  expect(
    screen.queryByPlaceholderText(
      messages.organization.aiConfig.modelIdPlaceholder,
    ),
  ).toBeNull();
  expect(screen.queryByText(AUTO_LABEL)).toBeNull();
  expect(screen.queryByText(CLOUD_MODEL.displayName)).toBeNull();

  await act(async () => {
    fireEvent.click(screen.getByText(messages.chat.localRun.cloud));
  });
  expect(chosen).toEqual([{ kind: "cloud" }]);
});

test("switching the thread back to stella cloud restores Auto and its models", async () => {
  const view = renderSelector(LOCAL_TARGET);
  view.rerender({ kind: "cloud" });
  expect(screen.getByRole("button", { name: AUTO_LABEL })).toBeTruthy();

  await openMenu(AUTO_LABEL);
  expect(await screen.findByText(messages.chat.localRun.runOn)).toBeTruthy();
  expect(
    screen.getByPlaceholderText(
      messages.organization.aiConfig.modelIdPlaceholder,
    ),
  ).toBeTruthy();
  expect(screen.getAllByText(AUTO_LABEL).length).toBeGreaterThan(1);
  expect(screen.getByText(CLOUD_MODEL.displayName)).toBeTruthy();
});
