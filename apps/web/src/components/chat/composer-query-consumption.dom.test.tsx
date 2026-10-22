import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import type { ChatInputMentionSource } from "@/components/chat-editor-provider";
import type { ChatMentionOption } from "@/components/chat-mention-extension";
import messages from "@/i18n/langs/en.json";
import type { McpConnectorsResponse } from "@/lib/knowledge/queries";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });
const previousApiUrl = process.env["VITE_API_URL"];
process.env["VITE_API_URL"] ??= "https://api.example.test";
const { act } = await import("react");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { Menu, MenuTrigger, MenuPopup } = await import("@stll/ui/menu");
const { ChatEditorProvider, useChatEditorManager } =
  await import("@/components/chat-editor-provider");
const { useMountEffect } = await import("@/hooks/use-effect");
const { toSafeId } = await import("@/lib/safe-id");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { aiAvailabilityOptions } =
  await import("@/lib/organization/ai-config-queries");
const { contextMentionSearchKey } = await import("./composer-plus-menu.logic");
const { toChatThreadId, getChatThreadKey } =
  await import("@/lib/chat-thread-ref");
const { skillsOptions, mcpConnectorsOptions, mcpConnectionsOptions } =
  await import("@/lib/knowledge/queries");
const { workspacesNavigationOptions } =
  await import("@/lib/workspaces/queries");
const { ComposerSkillsMenu, ComposerContextMenu, ComposerMcpSubmenu } =
  await import("./composer-plus-menu");

afterEach(cleanup);
afterAll(async () => {
  await act(async () => {});
  await unregisterDomEnvironment();
  if (previousApiUrl === undefined) {
    delete process.env["VITE_API_URL"];
  } else {
    process.env["VITE_API_URL"] = previousApiUrl;
  }
});
const organizationId = "composer-org";
const user = {
  activeOrganizationId: organizationId,
  email: "member@example.test",
  id: "composer-user",
  image: null,
  name: "Member",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const threadRef = {
  scope: "global",
  threadId: toChatThreadId("composer-thread"),
} as const;
const host = {
  kind: "shortcut",
  anchor: document.body,
  open: true,
  onClose: () => {},
  side: "top",
} as const;
const createClient = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, staleTime: Infinity },
    },
  });
  client.setQueryData(aiAvailabilityOptions({ organizationId }).queryKey, {
    available: true,
    deferredServiceTierAvailable: false,
    instanceProvisioned: false,
    mockAnswers: false,
    orgConfigured: true,
  });
  return client;
};
const markFailed = (
  client: InstanceType<typeof QueryClient>,
  queryKey: readonly unknown[],
) => {
  const query = client.getQueryCache().find({ queryKey });
  if (!query) {
    throw new Error("Expected seeded read");
  }
  query.setState({
    status: "error",
    error: new Error("Unavailable"),
    fetchStatus: "idle",
  });
};
const mount = (client: InstanceType<typeof QueryClient>, children: ReactNode) =>
  render(
    <ChatThreadTestRouter>
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <AuthenticatedUserProvider user={user}>
              <ChatEditorProvider>{children}</ChatEditorProvider>
            </AuthenticatedUserProvider>
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>
    </ChatThreadTestRouter>,
  );

test("the context menu reports its navigation read failure instead of no matters", async () => {
  const client = createClient();
  const options = workspacesNavigationOptions({
    organizationId,
    userId: user.id,
  });
  client.getQueryCache().build(client, { queryKey: options.queryKey });
  markFailed(client, options.queryKey);
  const ui = mount(
    client,
    <ComposerContextMenu
      enabled
      host={host}
      context={{
        activeOrganizationId: organizationId,
        editor: null,
        threadRef,
      }}
    />,
  );
  await waitFor(() => expect(ui.getByRole("alert")).toBeDefined());
  expect(ui.getByRole("button", { name: messages.common.retry })).toBeDefined();
  expect(ui.queryByText(messages.chat.composerMenu.noMatters)).toBeNull();
  client.clear();
});

test("the skills menu reports its catalog read failure instead of no skills", async () => {
  const client = createClient();
  const options = skillsOptions(organizationId, user.id);
  client.getQueryCache().build(client, { queryKey: options.queryKey });
  markFailed(client, options.queryKey);
  const ui = mount(
    client,
    <ComposerSkillsMenu
      enabled
      host={host}
      skills={{ activeOrganizationId: organizationId, editor: null }}
    />,
  );
  await waitFor(() => expect(ui.getByRole("alert")).toBeDefined());
  expect(ui.getByRole("button", { name: messages.common.retry })).toBeDefined();
  expect(ui.queryByText(messages.chat.composerMenu.noSkills)).toBeNull();
  client.clear();
});

for (const { failedSource, failedQueryKey } of [
  {
    failedSource: "connectors",
    failedQueryKey: mcpConnectorsOptions(organizationId).queryKey,
  },
  {
    failedSource: "connections",
    failedQueryKey: mcpConnectionsOptions(organizationId, user.id).queryKey,
  },
]) {
  test(`the MCP menu reports ${failedSource} failure without an empty inventory verdict`, async () => {
    const client = createClient();
    const connectors = mcpConnectorsOptions(organizationId);
    const connections = mcpConnectionsOptions(organizationId, user.id);
    client.setQueryData(connectors.queryKey, {
      connectors: [],
      canManageCustomConnectors: false,
      nativeTools: [],
    });
    client.setQueryData(connections.queryKey, { connections: [] });
    markFailed(client, failedQueryKey);
    const ui = mount(
      client,
      <Menu open>
        <MenuTrigger>{messages.chat.composerMenu.mcpServers}</MenuTrigger>
        <MenuPopup>
          <ComposerMcpSubmenu
            enabled
            guideAnchorsEnabled={false}
            mcp={{ activeOrganizationId: organizationId }}
          />
        </MenuPopup>
      </Menu>,
    );
    await waitFor(() =>
      expect(
        ui.getByRole("menuitem", {
          name: messages.chat.composerMenu.mcpServers,
        }),
      ).toBeDefined(),
    );
    fireEvent.click(
      ui.getByRole("menuitem", { name: messages.chat.composerMenu.mcpServers }),
    );
    await waitFor(() => expect(ui.getByRole("alert")).toBeDefined());
    expect(
      ui.getByRole("button", { name: messages.common.retry }),
    ).toBeDefined();
    expect(ui.queryByText(messages.chat.composerMenu.noMcpServers)).toBeNull();
    client.clear();
  });
}

test("the MCP menu retains catalog rows during an initial connections failure", async () => {
  const client = createClient();
  const connectors = mcpConnectorsOptions(organizationId);
  const connections = mcpConnectionsOptions(organizationId, user.id);
  client.setQueryData(connectors.queryKey, {
    connectors: [
      {
        id: toSafeId<"mcpConnector">("catalog-connector"),
        slug: "catalog",
        displayName: "Catalog connector",
        organizationId: null,
        description: "Catalog connector",
        url: "https://connector.example.test/mcp",
        authType: "none",
        isCurated: true,
        oauthRequestedScopes: null,
        allowedTools: null,
        documentationUrl: null,
        tokenHelpUrl: null,
        iconUrl: null,
        authorizationStatus: "not_required",
        authorizationReview: null,
        isRecommended: false,
        recommendedJurisdictions: [],
      },
    ],
    canManageCustomConnectors: false,
    nativeTools: [],
  } satisfies McpConnectorsResponse);
  client.getQueryCache().build(client, { queryKey: connections.queryKey });
  markFailed(client, connections.queryKey);
  const ui = mount(
    client,
    <Menu open>
      <MenuTrigger>{messages.chat.composerMenu.mcpServers}</MenuTrigger>
      <MenuPopup>
        <ComposerMcpSubmenu
          enabled
          guideAnchorsEnabled={false}
          mcp={{ activeOrganizationId: organizationId }}
        />
      </MenuPopup>
    </Menu>,
  );
  await waitFor(() =>
    expect(
      ui.getByRole("menuitem", { name: messages.chat.composerMenu.mcpServers }),
    ).toBeDefined(),
  );
  fireEvent.click(
    ui.getByRole("menuitem", { name: messages.chat.composerMenu.mcpServers }),
  );
  await waitFor(() => expect(ui.getByRole("alert")).toBeDefined());
  expect(ui.getByRole("button", { name: messages.common.retry })).toBeDefined();
  expect(ui.getByRole("menuitem", { name: "Catalog connector" })).toBeDefined();
  expect(ui.queryByText(messages.chat.composerMenu.noMcpServers)).toBeNull();
  client.clear();
});

test("the context search retains a failed empty refresh notice instead of no results", async () => {
  const client = createClient();
  const options = workspacesNavigationOptions({
    organizationId,
    userId: user.id,
  });
  client.setQueryData(options.queryKey, {
    workspaces: [],
    features: { timeBilling: false },
  });
  const ui = mount(
    client,
    <ComposerContextMenu
      enabled
      host={host}
      context={{
        activeOrganizationId: organizationId,
        editor: null,
        threadRef,
      }}
    />,
  );
  await waitFor(() =>
    expect(
      ui.getByPlaceholderText(messages.chat.composerMenu.searchMatters),
    ).toBeDefined(),
  );
  fireEvent.change(
    ui.getByPlaceholderText(messages.chat.composerMenu.searchMatters),
    { target: { value: "contract" } },
  );
  const queryKey = contextMentionSearchKey({
    organizationId,
    query: "contract",
    registrationVersion: 0,
    threadKey: getChatThreadKey(threadRef),
    userId: user.id,
  });
  await waitFor(() =>
    expect(client.getQueryCache().find({ queryKey })?.state.status).toBe(
      "success",
    ),
  );
  await act(async () => {
    markFailed(client, queryKey);
  });
  await waitFor(() => expect(ui.getByRole("alert")).toBeDefined());
  expect(ui.getByRole("button", { name: messages.common.retry })).toBeDefined();
  expect(ui.queryByText(messages.common.noResults)).toBeNull();
  client.clear();
});

const RegisteredMentionSources = ({
  sources,
}: {
  sources: ChatInputMentionSource[];
}) => {
  const { registerExtension } = useChatEditorManager();
  useMountEffect(() =>
    registerExtension("fault-injection", { mentionSources: sources }),
  );
  return (
    <ComposerContextMenu
      enabled
      host={host}
      context={{
        activeOrganizationId: organizationId,
        editor: null,
        threadRef,
      }}
    />
  );
};

for (const { failingRead, failure, withHealthy = true } of [
  { failingRead: "getItems", failure: new Error("Local source unavailable") },
  {
    failingRead: "searchItems",
    failure: new Error("Search source unavailable"),
  },
  { failingRead: "both", failure: new Error("Sources unavailable") },
  {
    failingRead: "both",
    failure: new Error("Sources unavailable"),
    withHealthy: false,
  },
]) {
  test(`a registered source ${failingRead} failure with healthy=${withHealthy} offers retry and recovery merges both successful sources`, async () => {
    const client = createClient();
    client.setQueryData(
      workspacesNavigationOptions({ organizationId, userId: user.id }).queryKey,
      {
        workspaces: [],
        features: { timeBilling: false },
      },
    );
    let unavailable = true;
    const local = {
      category: "decision",
      kind: "decision",
      label: "Contract local decision",
      mimeType: null,
      resource: resourceRef({
        type: RESOURCE_TYPE.CASE_LAW_DECISION,
        id: toSafeId<"caseLawDecision">("local-decision"),
      }),
    } satisfies ChatMentionOption;
    const searched = {
      category: "decision",
      kind: "decision",
      label: "Contract searched decision",
      mimeType: null,
      resource: resourceRef({
        type: RESOURCE_TYPE.CASE_LAW_DECISION,
        id: toSafeId<"caseLawDecision">("searched-decision"),
      }),
    } satisfies ChatMentionOption;
    const healthyLocal = {
      ...local,
      label: "Contract healthy local",
      resource: resourceRef({
        type: RESOURCE_TYPE.CASE_LAW_DECISION,
        id: toSafeId<"caseLawDecision">("healthy-local"),
      }),
    } satisfies ChatMentionOption;
    const healthySearch = {
      ...searched,
      label: "Contract healthy search",
      resource: resourceRef({
        type: RESOURCE_TYPE.CASE_LAW_DECISION,
        id: toSafeId<"caseLawDecision">("healthy-search"),
      }),
    } satisfies ChatMentionOption;
    const sources = [
      {
        id: "local-source",
        labelKey: "common.files",
        getItems: async () => {
          if (
            unavailable &&
            (failingRead === "getItems" || failingRead === "both")
          ) {
            throw failure;
          }
          return [local];
        },
      },
      {
        id: "search-source",
        labelKey: "common.caseLaw",
        getItems: () => [],
        searchItems: async () => {
          if (
            unavailable &&
            (failingRead === "searchItems" || failingRead === "both")
          ) {
            throw failure;
          }
          return [searched];
        },
      },
      {
        id: "healthy-source",
        labelKey: "common.files",
        getItems: () => (withHealthy ? [healthyLocal] : []),
        searchItems: async () => (withHealthy ? [healthySearch] : []),
      },
    ] satisfies ChatInputMentionSource[];
    const ui = mount(client, <RegisteredMentionSources sources={sources} />);
    await waitFor(() =>
      expect(
        ui.getByPlaceholderText(messages.chat.composerMenu.searchMatters),
      ).toBeDefined(),
    );
    fireEvent.change(
      ui.getByPlaceholderText(messages.chat.composerMenu.searchMatters),
      { target: { value: "contract" } },
    );
    await waitFor(() =>
      expect(ui.getAllByRole("alert")).toHaveLength(
        failingRead === "both" ? 2 : 1,
      ),
    );
    if (withHealthy) {
      expect(ui.getByText(healthyLocal.label)).toBeDefined();
      expect(ui.getByText(healthySearch.label)).toBeDefined();
    } else {
      expect(ui.queryByText(healthyLocal.label)).toBeNull();
      expect(ui.queryByText(healthySearch.label)).toBeNull();
    }
    expect(ui.queryByText(messages.common.noResults)).toBeNull();
    if (failingRead === "both") {
      expect(ui.getByText(messages.common.files)).toBeDefined();
      expect(ui.getByText(messages.common.caseLaw)).toBeDefined();
    }
    if (failingRead !== "both") {
      expect(
        ui.getByText(
          failingRead === "getItems"
            ? messages.common.files
            : messages.common.caseLaw,
        ),
      ).toBeDefined();
      expect(
        ui.getByText(failingRead === "getItems" ? searched.label : local.label),
      ).toBeDefined();
    }
    unavailable = false;
    const retries = ui.getAllByRole("button", { name: messages.common.retry });
    expect(retries).toHaveLength(failingRead === "both" ? 2 : 1);
    const retry = retries.at(0);
    if (!retry) {
      throw new Error("Expected source retry");
    }
    fireEvent.click(retry);
    await waitFor(() => expect(ui.getByText(local.label)).toBeDefined());
    expect(ui.getByText(searched.label)).toBeDefined();
    expect(ui.queryByRole("alert")).toBeNull();
    client.clear();
  });
}
