import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { FormattingProvider } from "@/i18n/formatting-context";
import en from "@/i18n/langs/en.json";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import { toChatThreadId } from "@/lib/chat-thread-ref";

beforeAll(() => {
  process.env["VITE_API_URL"] ??= "https://api.example.test";
});

const COMPOSER_CONTENT = "Composer";
const ORGANIZATION_ID = "org-query-state";
const USER = {
  activeOrganizationId: ORGANIZATION_ID,
  email: "member@example.test",
  id: "user-query-state",
  image: null,
  name: "Member",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
} satisfies AuthenticatedUser;

const createClient = () =>
  new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
const markFailed = (client: QueryClient, queryKey: readonly unknown[]) => {
  const query = client.getQueryCache().find({ queryKey });
  if (!query) {
    throw new Error("Expected seeded query");
  }
  query.setState({
    status: "error",
    error: new Error("Unavailable"),
    fetchStatus: "idle",
  });
};
const render = (client: QueryClient, children: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <AuthenticatedUserProvider user={USER}>
            {children}
          </AuthenticatedUserProvider>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

const models = {
  activeOrganizationId: ORGANIZATION_ID,
  threadRef: {
    scope: "global",
    threadId: toChatThreadId("thread-query-state"),
  },
  selectedModel: "provider::explicit-model",
  selectedReasoningEffort: null,
  selectModel: () => {},
} as const;

test("matter picker failure does not label selected context as no matter", async () => {
  const { ChatMatterPicker } = await import("./chat-matter-picker");
  const { workspacesNavigationOptions } =
    await import("@/lib/workspaces/queries");
  const client = createClient();
  const options = workspacesNavigationOptions({
    organizationId: ORGANIZATION_ID,
    userId: USER.id,
  });
  client.getQueryCache().build(client, { queryKey: options.queryKey });
  markFailed(client, options.queryKey);
  const markup = render(
    client,
    <ChatMatterPicker matterIds={["matter-1"]} onChange={() => {}} />,
  );
  expect(markup).toContain(en.common.somethingWentWrong);
  expect(markup).not.toContain(en.inspector.matterPicker.noMatter);
});

test("explicit model failure never labels the selector as auto", async () => {
  const { ChatModelSelector } = await import("./chat-model-selector");
  const { modelOptionsOptions } = await import("@/features/chat/queries");
  const client = createClient();
  const options = modelOptionsOptions(ORGANIZATION_ID);
  client.getQueryCache().build(client, { queryKey: options.queryKey });
  markFailed(client, options.queryKey);
  const markup = render(client, <ChatModelSelector models={models} />);
  expect(markup).toContain(en.common.somethingWentWrong);
  expect(markup).not.toContain(`>${en.chat.modelSelector.autoLabel}<`);
});

test("mention source failure shows a retry instead of silently removing choices", async () => {
  const { ChatMentionProviders } = await import("../chat-mention-providers");
  const { workspacesNavigationOptions } =
    await import("@/lib/workspaces/queries");
  const client = createClient();
  const options = workspacesNavigationOptions({
    organizationId: ORGANIZATION_ID,
    userId: USER.id,
  });
  client.getQueryCache().build(client, { queryKey: options.queryKey });
  markFailed(client, options.queryKey);
  const markup = render(
    client,
    <ChatMentionProviders>
      <span>{COMPOSER_CONTENT}</span>
    </ChatMentionProviders>,
  );
  expect(markup).toContain('role="alert"');
  expect(markup).toContain(en.common.retry);
  expect(markup).toContain(COMPOSER_CONTENT);
});

test("mention sources keep cached empty data with a failed refresh notice", async () => {
  const { ChatMentionProviders } = await import("../chat-mention-providers");
  const { workspacesNavigationOptions } =
    await import("@/lib/workspaces/queries");
  const client = createClient();
  const options = workspacesNavigationOptions({
    organizationId: ORGANIZATION_ID,
    userId: USER.id,
  });
  client.setQueryData(options.queryKey, {
    workspaces: [],
    features: { timeBilling: false },
  });
  markFailed(client, options.queryKey);
  const markup = render(
    client,
    <ChatMentionProviders>
      <span>{COMPOSER_CONTENT}</span>
    </ChatMentionProviders>,
  );
  expect(markup).toContain('role="alert"');
  expect(markup).toContain(en.common.retry);
  expect(markup).toContain(COMPOSER_CONTENT);
});

test("model options failure shows retry without a no-results verdict", async () => {
  const { Menu } = await import("@stll/ui/menu");
  const { ChatModelOptionsMenu } = await import("./chat-model-options-menu");
  const { modelOptionsOptions } = await import("@/features/chat/queries");
  const client = createClient();
  const options = modelOptionsOptions(ORGANIZATION_ID);
  client.getQueryCache().build(client, { queryKey: options.queryKey });
  markFailed(client, options.queryKey);
  const markup = render(
    client,
    <Menu>
      <ChatModelOptionsMenu enabled models={models} open />
    </Menu>,
  );
  expect(markup).toContain('role="alert"');
  expect(markup).toContain(en.common.retry);
  expect(markup).not.toContain(en.organization.aiConfig.noModelResults);
});

const CACHED_MODEL = {
  value: models.selectedModel,
  displayName: "Cached choice",
  modelId: "explicit-model",
  provider: "openai",
  iconProvider: "openai",
  defaultReasoningEffort: null,
  reasoningEfforts: null,
} as const;

for (const { description, cachedRows } of [
  { description: "an empty catalog", cachedRows: [] },
  { description: "model choices", cachedRows: [CACHED_MODEL] },
]) {
  test(`model options retain cached ${description} with a retry after refresh failure`, async () => {
    const { Menu } = await import("@stll/ui/menu");
    const { ChatModelOptionsMenu } = await import("./chat-model-options-menu");
    const { modelOptionsOptions } = await import("@/features/chat/queries");
    const {
      MODEL_BENCHMARK_LICENCE,
      MODEL_BENCHMARK_NAME,
      MODEL_BENCHMARK_PUBLISH_DATE,
      MODEL_BENCHMARK_SOURCE_URL,
      TYPICAL_CALL_INPUT_TOKENS,
      TYPICAL_CALL_OUTPUT_TOKENS,
    } = await import("@stll/ai-catalog/benchmarks");
    const client = createClient();
    const options = modelOptionsOptions(ORGANIZATION_ID);
    client.setQueryData(options.queryKey, {
      options: cachedRows,
      defaultValue: models.selectedModel,
      benchmarkOptions: [],
      benchmarkMetadata: {
        benchmarkName: MODEL_BENCHMARK_NAME,
        licence: MODEL_BENCHMARK_LICENCE,
        publishDate: MODEL_BENCHMARK_PUBLISH_DATE,
        sourceUrl: MODEL_BENCHMARK_SOURCE_URL,
        typicalCallInputTokens: TYPICAL_CALL_INPUT_TOKENS,
        typicalCallOutputTokens: TYPICAL_CALL_OUTPUT_TOKENS,
      },
    });
    markFailed(client, options.queryKey);
    const markup = render(
      client,
      <Menu>
        <ChatModelOptionsMenu enabled models={models} open />
      </Menu>,
    );
    for (const cachedRow of cachedRows) {
      expect(markup).toContain(cachedRow.displayName);
    }
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(en.common.retry);
    expect(markup).not.toContain(en.organization.aiConfig.noModelResults);
  });
}
