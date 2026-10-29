import { useState } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AnyRouter } from "@tanstack/react-router";
import { afterAll, afterEach, expect, jest, test } from "bun:test";

import { RESOURCE_TYPE, resourceRef, toResourceName } from "@stll/api-contract";
import {
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import { DOCUMENT_OCR_AVAILABILITY } from "@stll/api-contract/document-ocr-availability";
import {
  SEARCH_PAGE_REACH,
  SEARCH_PAGINATION_COMPLETE,
} from "@stll/api-contract/search";
import { restoreRealTimers } from "@stll/property-testing/fake-timers";

import type { api } from "@/lib/api";
import type { GlobalSearchHit } from "@/lib/api-contract";
import type { PublicLawData } from "@/lib/public-law-api";
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

const {
  createMatterViewTestRouter,
  EXPECTED_OTHER_TREE_REVEAL,
  seedTestMatterTrees,
  TEST_FOLDER_ID,
  TEST_MATTER_ID,
  TEST_OTHER_TREE_DOCUMENT_PATH,
} = await import("@/lib/workspaces/matter-view-test-router");
const folderResource = resourceRef({
  type: RESOURCE_TYPE.ENTITY,
  id: toSafeId<"entity">(TEST_FOLDER_ID),
});
const folderHit = {
  id: `entity:${TEST_FOLDER_ID}`,
  type: "folder",
  resource: folderResource,
  resourceName: toResourceName(folderResource),
  title: "Pleadings",
  headline: null,
  updatedAt: "2026-10-22T00:00:00.000Z",
  entityId: TEST_FOLDER_ID,
  workspaceId: TEST_MATTER_ID,
  workspaceName: "Civil proceeding",
  parentId: null,
  lastEditedByName: null,
  lastEditedByImage: null,
  fileFieldId: null,
  filePropertyId: null,
  mimeType: null,
} as const satisfies GlobalSearchHit;

const citationResponse = {
  hits: [
    {
      decisionId: "00000000-0000-4000-8000-000000000049",
      caseNumber: "22 As 40/2025",
      caseNumberType: "case-number",
      slug: "22-as-40-2025",
      ecli: "ECLI:CZ:NSS:2026:22.AS.40.2025.49",
      identifiers: [{ type: "case-number", value: "22 As 40/2025 - 49" }],
      court: "Nejvyšší správní soud",
      courtAbbreviation: "NSS",
      courtTier: "supreme",
      country: "CZE",
      language: "cs",
      languageAlternates: [],
      decisionDate: "2026-01-29",
      decisionType: "judgment",
      sourceUrl: null,
      headnote: {
        type: TEXT_FIELD_TYPE.ABSENT,
        reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
      },
      keywords: null,
      textWithheldReason: null,
      textAvailability: "available",
      headline: null,
      anchorId: null,
      citationCount: 0,
      citationAuthority: 0,
      matchingPassages: 1,
      match: "all_terms",
      createdAt: "2026-01-29T00:00:00.000Z",
    },
  ],
  facets: null,
  nextCursor: null,
  paginationOutcome: SEARCH_PAGINATION_COMPLETE,
  pageReach: SEARCH_PAGE_REACH.REACHED,
  total: { type: "exact", count: 1 },
  relaxedHitCount: 0,
  queryUsed: "22 As 40/2025 - 49",
  warnings: [],
} satisfies PublicLawData<typeof api.case.decisions.search.post>;

const searchRequestBodies: unknown[] = [];
let searchHits: readonly GlobalSearchHit[] = [hit];
let searchResponseGate: Promise<void> | null = null;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/case/decisions/search")) {
      return Response.json(citationResponse);
    }
    if (url.pathname.endsWith("/law/statutes")) {
      return Response.json({
        items: [],
        limit: 25,
        nextCursor: null,
      } satisfies PublicLawData<typeof api.law.statutes.get>);
    }
    if (url.pathname.endsWith("/search")) {
      searchRequestBodies.push(await request.json());
      await searchResponseGate;
      return Response.json({
        hits: searchHits,
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
const { assignUserStorage } = await import("@/lib/account/user-scoped-storage");
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
  searchHits = [hit];
  searchResponseGate = null;
  assignUserStorage(undefined);
  useDevStore.setState({ publicLawPreview: false });
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

const rootOnlyRouter = async () => {
  const appRouter = router.createRouter({
    routeTree: router.createRootRoute({ component: SearchDialogHarness }),
    history: router.createMemoryHistory({ initialEntries: ["/"] }),
    isServer: false,
  });
  await appRouter.load();
  return appRouter;
};

const mount = async (
  createAppRouter: () => Promise<AnyRouter> = rootOnlyRouter,
) => {
  const client = new query.QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(rootKeys.role, "member");
  seedTestMatterTrees(client);
  const appRouter = await createAppRouter();
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
                  ocr: DOCUMENT_OCR_AVAILABILITY.unconfigured,
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
  return appRouter;
};

const typeQuery = async (
  expectedTitle: string = hit.title,
  value = "engagement",
) => {
  const input = testing.screen.getByRole("combobox", {
    name: messages.common.search,
  });
  if (!(input instanceof HTMLInputElement)) {
    throw new TypeError("Search dialog combobox must be an input");
  }
  jest.useFakeTimers();
  await testing.act(async () => {
    testing.fireEvent.input(input, { target: { value } });
    jest.advanceTimersByTime(301);
    restoreRealTimers();
  });
  await testing.waitFor(() =>
    expect(testing.screen.getAllByText(expectedTitle).length).toBeGreaterThan(
      0,
    ),
  );
  return input;
};

test("actions stay on the blank screen and never sit above results", async () => {
  await mount();
  expect(testing.screen.getByText(messages.common.actions)).toBeTruthy();

  await typeQuery();
  expect(testing.screen.queryByText(messages.common.actions)).toBeNull();
});

test("a resolved citation is the first keyboard result above matter hits", async () => {
  useDevStore.setState({ publicLawPreview: true });
  const appRouter = await mount(async () => {
    const root = router.createRootRoute({ component: SearchDialogHarness });
    const decision = router.createRoute({
      getParentRoute: () => root,
      path: "/law/$country/cases/$court/$slug",
      component: () => null,
    });
    const citationRouter = router.createRouter({
      routeTree: root.addChildren([decision]),
      history: router.createMemoryHistory({ initialEntries: ["/"] }),
      isServer: false,
    });
    await citationRouter.load();
    return citationRouter;
  });
  const input = await typeQuery("22 As 40/2025", "22 As 40/2025 - 49");
  expect(searchRequestBodies).toContainEqual(
    expect.objectContaining({ query: '"22 As 40/2025 - 49"' }),
  );
  expect(
    testing.screen
      .getByRole("button", { name: messages.common.caseLaw })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  const options = testing.screen.getAllByRole("option");
  expect(options.at(0)?.textContent).toContain("22 As 40/2025");
  expect(options.some((option) => option.textContent.includes(hit.title))).toBe(
    true,
  );
  await testing.act(async () => {
    testing.fireEvent.keyDown(input, { key: "Home", code: "Home" });
    testing.fireEvent.keyDown(input, { key: "ArrowDown", code: "ArrowDown" });
  });
  const highlightedId = input.getAttribute("aria-activedescendant");
  expect(
    highlightedId &&
      document.querySelector(`[id="${highlightedId}"]`)?.textContent,
  ).toContain(hit.title);
  await testing.act(async () => {
    testing.fireEvent.keyDown(input, { key: "ArrowUp", code: "ArrowUp" });
  });
  const citationId = input.getAttribute("aria-activedescendant");
  expect(
    citationId && document.querySelector(`[id="${citationId}"]`)?.textContent,
  ).toContain("22 As 40/2025");
  await testing.act(async () => {
    testing.fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
  });
  await testing.waitFor(() => {
    expect(appRouter.state.location.pathname).toBe(
      "/law/cze/cases/nejvyssi-spravni-soud/22-as-40-2025",
    );
  });
  expect(testing.screen.getByTestId("dialog-state").textContent).toBe("closed");
});

test("citation expansion can be collapsed and ordinary keywords keep their search behavior", async () => {
  useDevStore.setState({ publicLawPreview: true });
  await mount();
  await typeQuery("22 As 40/2025", "22 As 40/2025");
  const caseLaw = testing.screen.getByRole("button", {
    name: messages.common.caseLaw,
  });
  expect(caseLaw.getAttribute("aria-expanded")).toBe("true");
  await testing.act(async () => {
    testing.fireEvent.click(caseLaw);
  });
  expect(caseLaw.getAttribute("aria-expanded")).toBe("false");

  await typeQuery(hit.title, "engagement");
  expect(caseLaw.getAttribute("aria-expanded")).toBe("false");
  expect(searchRequestBodies.at(-1)).toMatchObject({ query: "engagement" });
  await testing.act(async () => {
    testing.fireEvent.click(caseLaw);
  });
  await typeQuery(hit.title, "agreement");
  expect(caseLaw.getAttribute("aria-expanded")).toBe("true");

  await typeQuery("22 As 40/2025", "22 As 40/2025 - 49");
  expect(caseLaw.getAttribute("aria-expanded")).toBe("true");
});

test("a citation never displays stale loose keyword hits while its phrase search loads", async () => {
  useDevStore.setState({ publicLawPreview: true });
  await mount();
  await typeQuery();
  const gate = Promise.withResolvers<undefined>();
  searchResponseGate = gate.promise;
  await typeQuery("22 As 40/2025", "22 As 40/2025 - 49");
  expect(
    testing.screen
      .getAllByRole("option")
      .some((option) => option.textContent?.includes(hit.title)),
  ).toBe(false);
  await testing.act(async () => {
    gate.resolve(undefined);
  });
  await testing.waitFor(() => {
    expect(
      testing.screen
        .getAllByRole("option")
        .some((option) => option.textContent?.includes(hit.title)),
    ).toBe(true);
  });
});

test.each([
  "22 As 40/2025",
  "22 As 40/2025 - 49",
  "ECLI:CZ:NS:2019:25.CDO.1234.2019.1",
  "89/2012 Sb.",
])(
  "citation %s uses a whole phrase for matters and the raw query for Case Law",
  async (citation) => {
    useDevStore.setState({ publicLawPreview: true });
    await mount();
    await typeQuery(hit.title, citation);
    expect(searchRequestBodies).toContainEqual(
      expect.objectContaining({ query: `"${citation}"` }),
    );
    expect(searchRequestBodies).toContainEqual(
      expect.objectContaining({ query: citation, types: ["case-law"] }),
    );
    expect(
      testing.screen
        .getByRole("button", { name: messages.common.caseLaw })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  },
);

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

test("a folder result reveals the folder in the tree on screen, not the first tree", async () => {
  searchHits = [folderHit];
  assignUserStorage(user.id);
  const appRouter = await mount(
    async () =>
      await createMatterViewTestRouter(
        TEST_OTHER_TREE_DOCUMENT_PATH,
        SearchDialogHarness,
      ),
  );
  await typeQuery(folderHit.title);
  const row = testing.screen
    .getAllByText(folderHit.title)
    .map((title) => title.closest<HTMLElement>("[data-slot=command-item]"))
    .find((item) => item !== null);
  if (!row) {
    throw new TypeError("The folder result row must render");
  }
  await testing.act(async () => {
    testing.fireEvent.click(row);
  });

  await testing.waitFor(() =>
    expect({
      pathname: appRouter.state.location.pathname,
      search: appRouter.state.location.search,
    }).toEqual(EXPECTED_OTHER_TREE_REVEAL),
  );
});
