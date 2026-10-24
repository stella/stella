import { useState } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, jest, test } from "bun:test";

import { RESOURCE_TYPE, resourceRef, toResourceName } from "@stll/api-contract";

import type { GlobalSearchHit } from "@/lib/api-contract";
import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_BETA_FEATURES_ENABLED: "true",
});
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  value: 600,
});
const originalFetch = globalThis.fetch;
const resource = resourceRef({
  type: RESOURCE_TYPE.CHAT_THREAD,
  id: toSafeId<"chatThread">("thread_search_result"),
});
const hit = {
  id: "chat:thread_search_result",
  type: "chat",
  resource,
  resourceName: toResourceName(resource),
  title: "Engagement letter",
  headline: null,
  updatedAt: "2026-10-22T00:00:00.000Z",
  threadId: "thread_search_result",
  workspaceId: null,
  workspaceName: null,
} as const satisfies GlobalSearchHit;

const searchRequestBodies: unknown[] = [];
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/search")) {
      searchRequestBodies.push(await request.json());
      return Response.json({
        hits: [hit],
        nextCursor: null,
        totalCount: 1,
        facets: { editor: [], mimeType: [], type: [], workspace: [] },
        previewLocatorCandidates: [],
      });
    }
    throw new TypeError(
      `Unexpected search dialog test request: ${url.pathname}`,
    );
  },
  { preconnect: () => undefined },
);

const testing = await import("@testing-library/react");
const query = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { noopAnalytics } = await import("@/lib/analytics/noop");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { rootKeys } = await import("@/lib/auth-queries");
const { ActionCapabilitiesProvider } =
  await import("@/lib/organization/feature-access/capability-actions");
const { resolveActionCapabilities } =
  await import("@/lib/organization/feature-access/action-capabilities.logic");
const { useDevStore } = await import("@/lib/dev-store");
const { SearchDialog } = await import("./search-dialog");

const SearchDialogHarness = () => {
  const [open, setOpen] = useState(true);
  return (
    <>
      <span data-testid="dialog-state">{open ? "open" : "closed"}</span>
      <SearchDialog open={open} onOpenChange={setOpen} />
    </>
  );
};

const clients: InstanceType<typeof query.QueryClient>[] = [];
afterEach(() => {
  testing.cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  searchRequestBodies.length = 0;
  useDevStore.setState({ publicLawPreview: false });
  jest.useRealTimers();
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
  await unregisterDomEnvironment();
});

const user = {
  activeOrganizationId: "organization_search_dialog",
  id: "user_search_dialog",
  email: "reader@example.test",
  image: null,
  name: "Reader",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};

const mount = async () => {
  const client = new query.QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(rootKeys.role, "member");
  const root = router.createRootRoute({
    component: SearchDialogHarness,
  });
  const appRouter = router.createRouter({
    routeTree: root,
    history: router.createMemoryHistory({ initialEntries: ["/"] }),
    isServer: false,
  });
  await appRouter.load();
  testing.render(
    <AnalyticsContext value={noopAnalytics}>
      <query.QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <AuthenticatedUserProvider user={user}>
              <ActionCapabilitiesProvider
                value={resolveActionCapabilities({
                  ai: false,
                  deepl: false,
                  desktop: "none",
                  ocr: false,
                  role: "member",
                  settings: undefined,
                })}
              >
                <router.RouterProvider router={appRouter} />
              </ActionCapabilitiesProvider>
            </AuthenticatedUserProvider>
          </FormattingProvider>
        </IntlProvider>
      </query.QueryClientProvider>
    </AnalyticsContext>,
  );
};

const typeQuery = async () => {
  const input = testing.screen.getByRole("combobox", {
    name: messages.common.search,
  });
  if (!(input instanceof HTMLInputElement)) {
    throw new TypeError("Search dialog combobox must be an input");
  }
  jest.useFakeTimers();
  await testing.act(async () => {
    testing.fireEvent.input(input, { target: { value: "engagement" } });
    jest.advanceTimersByTime(301);
    jest.useRealTimers();
  });
  await testing.waitFor(() =>
    expect(testing.screen.getAllByText(hit.title).length).toBeGreaterThan(0),
  );
  return input;
};

test("actions stay on the blank screen and never sit above results", async () => {
  await mount();
  expect(testing.screen.getByText(messages.common.actions)).toBeTruthy();

  await typeQuery();
  expect(testing.screen.queryByText(messages.common.actions)).toBeNull();
});

test("Case law scope searches only case law and drops matter recents and actions", async () => {
  useDevStore.setState({ publicLawPreview: true });
  await mount();
  await testing.act(async () => {
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: messages.search.scopeFilter }),
    );
  });
  await testing.act(async () => {
    testing.fireEvent.click(
      await testing.screen.findByRole("button", {
        name: messages.common.caseLaw,
      }),
    );
  });

  expect(
    testing.screen.getByText(messages.search.caseLawEmptyState),
  ).toBeTruthy();
  expect(testing.screen.queryByText(messages.search.emptyState)).toBeNull();
  expect(testing.screen.queryByText(messages.common.actions)).toBeNull();

  await typeQuery();
  expect(searchRequestBodies.at(-1)).toMatchObject({ types: ["case-law"] });
});

test.each([
  { focusResult: false, label: "input" },
  { focusResult: true, label: "result" },
])(
  "Esc clears results from the $label before closing the real search dialog",
  async ({ focusResult }) => {
    await mount();
    const input = await typeQuery();
    const target = focusResult
      ? document.querySelector<HTMLElement>("[data-slot=command-item]")
      : input;
    if (!target) {
      throw new TypeError("Search result row must render");
    }
    target.focus();
    await testing.act(async () => {
      testing.fireEvent.keyDown(target, { key: "Escape" });
    });

    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(testing.screen.getByTestId("dialog-state").textContent).toBe("open");
    expect(testing.screen.queryByText(hit.title)).toBeNull();

    await testing.act(async () => {
      testing.fireEvent.keyDown(input, { key: "Escape" });
    });
    await testing.waitFor(() =>
      expect(testing.screen.getByTestId("dialog-state").textContent).toBe(
        "closed",
      ),
    );
  },
);
