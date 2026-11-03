import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { requireBrowserStorage } from "@/lib/account/browser-storage";
import { MCP_OAUTH_REQUEST_STORAGE_KEY } from "@/lib/account/storage-keys";
import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });
const originalFetch = globalThis.fetch;
const requests: { path: string; method: string }[] = [];
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/auth/")) {
      return Response.json(null);
    }
    requests.push({ path, method: request.method });
    return Response.json({
      type: "oauth2",
      authorizeUrl: "https://example.test/authorize",
    });
  },
  { preconnect: () => undefined },
);
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { mcpConnectionsOptions, mcpConnectorsOptions } =
  await import("@/lib/knowledge/queries");
const { default: messages } = await import("@/i18n/langs/en.json");
const { default: arabicMessages } = await import("@/i18n/langs/ar.json");
const { broadcastMcpOAuthOutcome } = await import("@/lib/mcp-oauth-channel");
const { McpReconnectButton } = await import("./mcp-reconnect-button");
const { McpReconnectNotice, McpReconnectNoticeContent } =
  await import("./chat/mcp-reconnect-notice");
const { assignUserStorage, releaseUserStorage } =
  await import("@/lib/account/user-scoped-storage");
const { Editor } = await import("@tiptap/core");
const { default: Document } = await import("@tiptap/extension-document");
const { default: Paragraph } = await import("@tiptap/extension-paragraph");
const { default: Text } = await import("@tiptap/extension-text");
const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  requests.length = 0;
  releaseUserStorage();
});

const brokenConnection = {
  id: toSafeId<"mcpUserConnection">("00000000-0000-4000-8000-000000000001"),
  slug: "example-server",
  displayName: "Example Server",
  status: "needs_reauth",
  authType: "oauth2",
  expiresAt: "2026-10-12T00:00:00Z",
} as const satisfies Parameters<
  typeof McpReconnectNoticeContent
>[0]["candidates"][number];
type NoticeCandidate = Parameters<
  typeof McpReconnectNoticeContent
>[0]["candidates"][number];
type NoticeOptions = {
  text?: string;
  locale?: "en" | "ar";
  additional?: readonly NoticeCandidate[];
};
const noticeTree = (
  candidate: NoticeCandidate,
  {
    text = "Use Example Server",
    locale = "en",
    additional = [],
  }: NoticeOptions = {},
) => {
  const client = clients.at(0) ?? new QueryClient();
  if (clients.length === 0) {
    clients.push(client);
  }
  return (
    <QueryClientProvider client={client}>
      <AuthenticatedUserProvider
        user={{
          activeOrganizationId: "org-1",
          id: "user-1",
          email: "user@example.test",
          image: null,
          name: "Member",
          preferredName: null,
          timezoneId: "UTC",
          wordEditShortcut: null,
        }}
      >
        <IntlProvider
          locale={locale}
          messages={locale === "ar" ? arabicMessages : messages}
          timeZone="UTC"
        >
          <McpReconnectNoticeContent
            candidates={[candidate, ...additional]}
            text={text}
          />
        </IntlProvider>
      </AuthenticatedUserProvider>
    </QueryClientProvider>
  );
};

test("composer notice reads only mounted editors across their lifecycle", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  clients.push(client);
  const connectorId = toSafeId<"mcpConnector">(
    "00000000-0000-4000-8000-000000000002",
  );
  client.setQueryData(mcpConnectionsOptions("org-1", "user-1").queryKey, {
    connections: [
      {
        id: brokenConnection.id,
        connectorId,
        connectorSlug: brokenConnection.slug,
        responseDisposition: "normal",
        status: "needs_approval",
        enabled: true,
        scope: null,
        expiresAt: null,
        lastUsedAt: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
  });
  client.setQueryData(mcpConnectorsOptions("org-1").queryKey, {
    canManageCustomConnectors: false,
    nativeTools: [],
    connectors: [
      {
        id: connectorId,
        slug: brokenConnection.slug,
        organizationId: null,
        displayName: brokenConnection.displayName,
        description: "",
        url: "https://example.test/mcp",
        authType: "oauth2",
        isCurated: false,
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
  });
  const createEditor = (element: HTMLElement | null) =>
    new Editor({
      element,
      extensions: [Document, Paragraph, Text],
      content: "<p>Example Server</p>",
    });
  const unmounted = createEditor(null);
  const destroyed = createEditor(document.createElement("div"));
  const mounted = createEditor(document.createElement("div"));
  expect(unmounted.isInitialized).toBe(false);
  expect(unmounted.isDestroyed).toBe(true);
  expect(unmounted.getText()).toBe(brokenConnection.displayName);
  expect(destroyed.getText()).toBe(brokenConnection.displayName);
  destroyed.destroy();
  expect(destroyed.schema).toBeNull();
  expect(destroyed.isDestroyed).toBe(true);
  const tree = (editor: InstanceType<typeof Editor> | null) => (
    <QueryClientProvider client={client}>
      <AuthenticatedUserProvider
        user={{
          activeOrganizationId: "org-1",
          id: "user-1",
          email: "user@example.test",
          image: null,
          name: "Member",
          preferredName: null,
          timezoneId: "UTC",
          wordEditShortcut: null,
        }}
      >
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <McpReconnectNotice editor={editor} />
        </IntlProvider>
      </AuthenticatedUserProvider>
    </QueryClientProvider>
  );
  try {
    for (const editor of [null, destroyed, unmounted]) {
      const view = render(tree(editor));
      expect(
        screen.queryByRole("button", {
          name: messages.chat.mcpReconnect.dismiss,
        }),
      ).toBeNull();
      view.unmount();
    }
    render(tree(mounted));
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: messages.chat.mcpReconnect.dismiss,
        }),
      ).toBeDefined(),
    );
  } finally {
    unmounted.destroy();
    mounted.destroy();
  }
});

test("approval waiting copy has no reconnect action", () => {
  assignUserStorage("user-1");
  render(noticeTree({ ...brokenConnection, status: "needs_approval" }));
  expect(
    screen.queryByRole("button", { name: messages.knowledge.mcp.reconnect }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: messages.chat.mcpReconnect.dismiss }),
  ).toBeDefined();
  expect(screen.queryByRole("link")).toBeNull();
});

test("a recovered connection can show a new break even without an expiry", async () => {
  assignUserStorage("user-1");
  const candidate = { ...brokenConnection, expiresAt: null };
  const view = render(noticeTree(candidate));
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: messages.chat.mcpReconnect.dismiss }),
    );
  });
  expect(
    screen.queryByRole("button", { name: messages.knowledge.mcp.reconnect }),
  ).toBeNull();
  view.rerender(noticeTree({ ...candidate, status: "connected" }));
  view.rerender(noticeTree(candidate));
  expect(
    screen.getByRole("button", { name: messages.knowledge.mcp.reconnect }),
  ).toBeDefined();
});

test("typing the same mention again preserves the announcement node", () => {
  const view = render(noticeTree(brokenConnection));
  const announcement = view.container.querySelector('[aria-live="polite"] p');
  expect(announcement).not.toBeNull();
  view.rerender(noticeTree(brokenConnection, { text: "Something else" }));
  expect(view.container.querySelector('[aria-live="polite"] p')).toBe(
    announcement,
  );
  expect(
    screen.queryByRole("button", { name: messages.knowledge.mcp.reconnect }),
  ).toBeNull();
  view.rerender(noticeTree(brokenConnection));
  expect(view.container.querySelector('[aria-live="polite"] p')).toBe(
    announcement,
  );
});

for (const { removal } of [
  { removal: "mention" },
  { removal: "dismiss" },
] as const) {
  test(`OAuth completion refreshes connections after notice removal by ${removal}`, async () => {
    assignUserStorage("user-1");
    const view = render(noticeTree(brokenConnection));
    const client = clients.at(0);
    const key = mcpConnectionsOptions("org-1", "user-1").queryKey;
    client?.setQueryData(key, { connections: [] });
    const open = spyOn(window, "open").mockImplementation(() => window);
    try {
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: messages.knowledge.mcp.reconnect,
          }),
        );
      });
      await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
      if (removal === "mention") {
        view.rerender(noticeTree(brokenConnection, { text: "Something else" }));
      } else {
        await act(async () => {
          fireEvent.click(
            screen.getByRole("button", {
              name: messages.chat.mcpReconnect.dismiss,
            }),
          );
        });
      }
      expect(
        screen.queryByRole("button", {
          name: messages.knowledge.mcp.reconnect,
        }),
      ).toBeNull();
      expect(client?.getQueryState(key)?.isInvalidated).toBe(false);
      await act(async () => {
        broadcastMcpOAuthOutcome({ status: "connected" });
      });
      await waitFor(() =>
        expect(client?.getQueryState(key)?.isInvalidated).toBe(true),
      );
    } finally {
      open.mockRestore();
    }
  });
}

test("multiple matches share one notice, show two names and isolate names in Arabic", () => {
  const view = render(
    noticeTree(brokenConnection, {
      locale: "ar",
      text: "Example Server Another Server Third Server Fourth Server",
      additional: [
        {
          ...brokenConnection,
          id: toSafeId<"mcpUserConnection">(
            "00000000-0000-4000-8000-000000000002",
          ),
          slug: "another-server",
          displayName: "Another Server",
        },
        {
          ...brokenConnection,
          id: toSafeId<"mcpUserConnection">(
            "00000000-0000-4000-8000-000000000003",
          ),
          slug: "third-server",
          displayName: "Third Server",
        },
        {
          ...brokenConnection,
          id: toSafeId<"mcpUserConnection">(
            "00000000-0000-4000-8000-000000000004",
          ),
          slug: "fourth-server",
          displayName: "Fourth Server",
        },
      ],
    }),
  );
  expect(
    screen.getAllByRole("button", {
      name: arabicMessages.chat.mcpReconnect.dismiss,
    }),
  ).toHaveLength(1);
  expect(
    screen.getAllByRole("button", {
      name: arabicMessages.knowledge.mcp.reconnect,
    }),
  ).toHaveLength(2);
  const visible = view.container.querySelector(".bg-muted\\/40");
  expect(visible?.textContent).toContain("Example Server");
  expect(visible?.textContent).toContain("Another Server");
  expect(visible?.textContent).not.toContain("Third Server");
  expect(visible?.textContent).toMatch(/\+[2٢] اتصالان إضافيان/u);
  expect(visible?.querySelectorAll("bdi")).toHaveLength(2);
});

test("dismissal hides only the same connection break", async () => {
  assignUserStorage("user-1");
  const view = render(noticeTree(brokenConnection));
  expect(
    screen.getByRole("button", { name: messages.knowledge.mcp.reconnect }),
  ).toBeDefined();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: messages.chat.mcpReconnect.dismiss }),
    );
  });
  expect(
    screen.queryByRole("button", { name: messages.knowledge.mcp.reconnect }),
  ).toBeNull();
  view.rerender(noticeTree(brokenConnection));
  expect(
    screen.queryByRole("button", { name: messages.knowledge.mcp.reconnect }),
  ).toBeNull();
  view.rerender(
    noticeTree({ ...brokenConnection, expiresAt: "2026-10-13T00:00:00Z" }),
  );
  expect(
    screen.getByRole("button", { name: messages.knowledge.mcp.reconnect }),
  ).toBeDefined();
  view.rerender(noticeTree({ ...brokenConnection, status: "revoked" }));
  expect(
    screen.getByRole("button", { name: messages.knowledge.mcp.reconnect }),
  ).toBeDefined();
  view.rerender(
    noticeTree({
      ...brokenConnection,
      id: toSafeId<"mcpUserConnection">("00000000-0000-4000-8000-000000000005"),
    }),
  );
  expect(
    screen.getByRole("button", { name: messages.knowledge.mcp.reconnect }),
  ).toBeDefined();
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const mount = async (
  authType: "oauth2" | "bearer",
  slugs = ["example-server"],
) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const root = router.createRootRoute({ component: router.Outlet });
  const chat = router.createRoute({
    getParentRoute: () => root,
    path: "/chat",
    component: () => (
      <>
        {slugs.map((slug) => (
          <McpReconnectButton key={slug} authType={authType} slug={slug} />
        ))}
      </>
    ),
  });
  const tools = router.createRoute({
    getParentRoute: () => root,
    path: "/knowledge/tools",
    component: () => <p>{messages.settings.connections.integrationsTitle}</p>,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/chat"] }),
    routeTree: root.addChildren([chat, tools]),
    isServer: false,
  });
  await appRouter.load();
  render(
    <QueryClientProvider client={client}>
      <AuthenticatedUserProvider
        user={{
          activeOrganizationId: "org-1",
          id: "user-1",
          email: "user@example.test",
          image: null,
          name: "Member",
          preferredName: null,
          timezoneId: "UTC",
          wordEditShortcut: null,
        }}
      >
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <router.RouterProvider router={appRouter} />
        </IntlProvider>
      </AuthenticatedUserProvider>
    </QueryClientProvider>,
  );
  return { client, appRouter };
};

test("OAuth reconnect opens the authorization window and refreshes connections on callback", async () => {
  const { client } = await mount("oauth2");
  const key = mcpConnectionsOptions("org-1", "user-1").queryKey;
  client.setQueryData(key, { connections: [] });
  const open = spyOn(window, "open").mockImplementation(() => window);
  try {
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: messages.knowledge.mcp.reconnect }),
      );
    });
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "https://example.test/authorize",
        "_blank",
        "width=560,height=720",
      ),
    );
    expect(requests).toEqual([
      { path: "/v1/mcp/connectors/example-server/connect", method: "POST" },
    ]);
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    await act(async () => {
      broadcastMcpOAuthOutcome({ status: "connected" });
    });
    await waitFor(() =>
      expect(client.getQueryState(key)?.isInvalidated).toBe(true),
    );
  } finally {
    open.mockRestore();
  }
});

test("bearer reconnect opens its tools entry without starting OAuth", async () => {
  const { appRouter } = await mount("bearer");
  const link = screen.getByRole("link", {
    name: messages.knowledge.mcp.reconnect,
  });
  expect(link.getAttribute("href")).toBe(
    "/knowledge/tools?slug=example-server",
  );
  await act(async () => {
    fireEvent.click(link);
  });
  await waitFor(() =>
    expect(appRouter.state.location.href).toBe(
      "/knowledge/tools?slug=example-server",
    ),
  );
  expect(requests).toEqual([]);
});

test("two concurrent reconnects handle their own completion independently", async () => {
  const { stellaToast } = await import("@stll/ui/toast");
  const toast = spyOn(stellaToast, "add");
  const open = spyOn(window, "open").mockReturnValue(window);
  try {
    await mount("oauth2", ["example-server", "second-server"]);
    const buttons = screen.getAllByRole("button", {
      name: messages.knowledge.mcp.reconnect,
    });
    const first = buttons.at(0);
    const second = buttons.at(1);
    if (!first || !second) {
      throw new TypeError("Both reconnect controls must be mounted");
    }
    await act(async () => {
      fireEvent.click(first);
    });
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const firstNonce = requireBrowserStorage("session")
      .unwrap()
      .getItem(MCP_OAUTH_REQUEST_STORAGE_KEY);
    await act(async () => {
      fireEvent.click(second);
    });
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    const secondNonce = requireBrowserStorage("session")
      .unwrap()
      .getItem(MCP_OAUTH_REQUEST_STORAGE_KEY);
    if (!firstNonce || !secondNonce) {
      throw new TypeError("Each reconnect must hold a nonce");
    }
    expect(firstNonce).not.toBe(secondNonce);
    await act(async () => {
      requireBrowserStorage("session")
        .unwrap()
        .setItem(MCP_OAUTH_REQUEST_STORAGE_KEY, firstNonce);
      broadcastMcpOAuthOutcome({ status: "connected" });
    });
    await act(async () => {
      requireBrowserStorage("session")
        .unwrap()
        .setItem(MCP_OAUTH_REQUEST_STORAGE_KEY, secondNonce);
      broadcastMcpOAuthOutcome({ status: "error", reason: "cancelled" });
    });
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    await act(async () => {
      requireBrowserStorage("session")
        .unwrap()
        .setItem(MCP_OAUTH_REQUEST_STORAGE_KEY, firstNonce);
      broadcastMcpOAuthOutcome({ status: "error", reason: "cancelled" });
    });
    expect(toast).toHaveBeenCalledTimes(1);
  } finally {
    toast.mockRestore();
    open.mockRestore();
  }
});
