import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  jest,
  setDefaultTimeout,
  test,
} from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";

import { restoreRealTimers } from "@stll/property-testing/fake-timers";

import type { WebApiRoutes } from "@/lib/api";
import type { WorkspaceNavigationItem } from "@/lib/memory-api";
import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

// Wide enough that rows are not in their narrow layout.
GlobalRegistrator.register({
  url: "http://localhost:3000/chat/history",
  width: 1280,
});
// A hung test fails instead of holding the run. Assertions compare strings
// and booleans, never DOM nodes: a failing match on a node makes the runner
// print the whole document graph.
setDefaultTimeout(10_000);

const previousFetch = globalThis.fetch;
const testing = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { useSyncExternalStore } = await import("react");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { noopAnalytics } = await import("@/lib/analytics/noop");
const { workspacesNavigationOptions } =
  await import("@/lib/workspaces/queries");
const { RenderLoopGuard } = await import("@/testing/render-loop-guard");
const { ChatHistoryPage } = await import("./chat-history-page");

type ChatHistorySearch = Parameters<typeof ChatHistoryPage>[0]["search"];
type ThreadsPage = WebApiRoutes["chat"]["threads"]["get"]["response"][200];
type ThreadSlice = ThreadsPage["global"][number];

// "Today" is 2026-10-11 for the reader below, whose time zone is UTC.
const NOW = new Date("2026-10-11T12:00:00.000Z");

const user = {
  activeOrganizationId: "00000000-0000-7000-8000-00000000ffff",
  id: "00000000-0000-7000-8000-00000000fffe",
  email: "reader@example.test",
  image: null,
  name: "Reader",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};

const MATTER_A = {
  client: null,
  clientId: null,
  color: null,
  defaultViewId: null,
  id: toSafeId<"workspace">("00000000-0000-7000-8000-0000000000a1"),
  lastActivityAt: NOW,
  name: "Novak v. Horak",
  reference: "M-2026-001",
  status: "active",
} satisfies WorkspaceNavigationItem;
const MATTER_B = {
  ...MATTER_A,
  id: toSafeId<"workspace">("00000000-0000-7000-8000-0000000000b2"),
  name: "Lease renewal Vinohrady",
  reference: "M-2026-002",
} satisfies WorkspaceNavigationItem;

const thread = (id: string, title: string, updatedAt: string): ThreadSlice => ({
  context: { fileCount: 0, files: [], matterCount: 0, matters: [] },
  createdAt: updatedAt,
  decision: null,
  id,
  origin: "original",
  title,
  updatedAt,
  usedAnonymization: false,
});

const TODAY_GLOBAL = thread(
  "00000000-0000-7000-8000-000000000001",
  "Limitation period for unpaid invoices",
  "2026-10-11T09:00:00.000Z",
);
const THIS_WEEK_IN_A = thread(
  "00000000-0000-7000-8000-000000000002",
  "Draft statement of claim",
  "2026-10-08T09:00:00.000Z",
);
const OLDER_IN_B = thread(
  "00000000-0000-7000-8000-000000000003",
  "Termination notice for the lease",
  "2026-09-01T09:00:00.000Z",
);

type Server = {
  global: ThreadSlice[];
  workspaces: {
    workspaceId: string;
    workspaceName: string;
    threads: ThreadSlice[];
  }[];
};

const fullServer = (): Server => ({
  global: [TODAY_GLOBAL],
  workspaces: [
    {
      workspaceId: MATTER_A.id,
      workspaceName: MATTER_A.name,
      threads: [THIS_WEEK_IN_A],
    },
    {
      workspaceId: MATTER_B.id,
      workspaceName: MATTER_B.name,
      threads: [OLDER_IN_B],
    },
  ],
});

const listRequests: URL[] = [];
const deleteRequests: URL[] = [];
const unexpected: string[] = [];
const clients: InstanceType<typeof QueryClient>[] = [];

type ServedThread = {
  slice: ThreadSlice;
  workspace: { workspaceId: string; workspaceName: string } | null;
};

/**
 * One page of the list the way the API cuts it: newest first, search (titles)
 * and the matter filter applied before the page, the cursor an offset.
 */
const listPage = (server: Server, url: URL, pageSize: number): ThreadsPage => {
  const term = url.searchParams.get("search")?.toLowerCase() ?? "";
  const matterId = url.searchParams.get("workspaceId");
  const all: ServedThread[] = [
    ...server.global.map((slice) => ({ slice, workspace: null })),
    ...server.workspaces.flatMap(({ threads, ...workspace }) =>
      threads.map((slice) => ({ slice, workspace })),
    ),
  ]
    .filter(({ slice }) => slice.title.toLowerCase().includes(term))
    .filter(
      ({ workspace }) =>
        matterId === null || workspace?.workspaceId === matterId,
    )
    .toSorted(
      (left, right) =>
        Date.parse(right.slice.updatedAt) - Date.parse(left.slice.updatedAt),
    );
  const offset = Number(url.searchParams.get("cursor") ?? "0");
  const page = all.slice(offset, offset + pageSize);
  const workspaces: ThreadsPage["workspaces"] = [];
  for (const { slice, workspace } of page) {
    if (workspace === null) {
      continue;
    }
    const group = workspaces.find(
      ({ workspaceId }) => workspaceId === workspace.workspaceId,
    );
    if (group === undefined) {
      workspaces.push({ ...workspace, threads: [slice] });
      continue;
    }
    group.threads.push(slice);
  }
  return {
    global: page
      .filter(({ workspace }) => workspace === null)
      .map(({ slice }) => slice),
    nextCursor:
      offset + pageSize < all.length ? String(offset + pageSize) : null,
    workspaces,
  };
};

/** Serves the history list and thread deletes. */
const serve = (
  server: Server,
  {
    matterStatus = 200,
    pageSize = 50,
  }: {
    /** How the API answers a matter-filtered list read. */
    matterStatus?: 200 | 404 | 500;
    pageSize?: number;
  } = {},
) => {
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/chat/threads") && request.method === "GET") {
        listRequests.push(url);
        if (url.searchParams.has("workspaceId") && matterStatus !== 200) {
          return Response.json(
            {
              message:
                matterStatus === 404 ? "Workspace not found" : "Server error",
            },
            { status: matterStatus },
          );
        }
        return Response.json(listPage(server, url, pageSize));
      }
      const deleted = /\/chat\/threads\/([^/]+)$/u.exec(url.pathname);
      if (deleted !== null && request.method === "DELETE") {
        deleteRequests.push(url);
        const id = deleted[1];
        server.global = server.global.filter((slice) => slice.id !== id);
        for (const group of server.workspaces) {
          group.threads = group.threads.filter((slice) => slice.id !== id);
        }
        return Response.json({});
      }
      unexpected.push(`${request.method} ${url.pathname}`);
      return Response.json(
        { message: `Unexpected history test request: ${url.pathname}` },
        { status: 500 },
      );
    },
    { preconnect: previousFetch.preconnect },
  );
};

afterEach(() => {
  testing.cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  globalThis.fetch = previousFetch;
  listRequests.length = 0;
  deleteRequests.length = 0;
  unexpected.length = 0;
});
afterAll(async () => {
  await testing.act(async () => {
    await sleep(50);
  });
  await unregisterDomEnvironment();
});

const createClient = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(
    workspacesNavigationOptions({
      organizationId: user.activeOrganizationId,
      userId: user.id,
    }).queryKey,
    { workspaces: [MATTER_A, MATTER_B], features: { timeBilling: false } },
  );
  return client;
};

/** The page as its route mounts it, with the URL's search held in state. */
const openHistory = async (initial: ChatHistorySearch = {}) => {
  const searchChanges: ChatHistorySearch[] = [];
  // The URL's search, held outside the page so a test can also change it the
  // way Back, Forward or a link would.
  let current = initial;
  const listeners = new Set<() => void>();
  const setSearch = (next: ChatHistorySearch) => {
    current = next;
    for (const listener of listeners) {
      listener();
    }
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const Host = () => {
    const search = useSyncExternalStore(subscribe, () => current);
    return (
      <ChatHistoryPage
        onSearchChange={(next) => {
          searchChanges.push(next);
          setSearch(next);
        }}
        search={search}
      />
    );
  };
  const root = router.createRootRoute({ component: router.Outlet });
  const protectedRoute = router.createRoute({
    getParentRoute: () => root,
    id: "_protected",
    beforeLoad: () => ({ user }),
    component: router.Outlet,
  });
  const routes = [
    router.createRoute({
      getParentRoute: () => protectedRoute,
      path: "/chat/history",
      component: Host,
    }),
    router.createRoute({
      getParentRoute: () => protectedRoute,
      path: "/chat",
      component: () => null,
    }),
    router.createRoute({
      getParentRoute: () => protectedRoute,
      path: "/chat/$threadId",
      component: () => null,
    }),
    router.createRoute({
      getParentRoute: () => protectedRoute,
      path: "/chat/workspaces/$workspaceId/$threadId",
      component: () => null,
    }),
  ];
  const appRouter = router.createRouter({
    routeTree: root.addChildren([protectedRoute.addChildren(routes)]),
    history: router.createMemoryHistory({ initialEntries: ["/chat/history"] }),
    isServer: false,
  });
  await appRouter.load();
  const ui = testing.render(
    <AnalyticsContext value={noopAnalytics}>
      <RenderLoopGuard>
        <QueryClientProvider client={createClient()}>
          {/* Pin calendar grouping without freezing Date.now(), which the
              debounce uses to decide whether its trailing timer can fire. */}
          <IntlProvider
            locale="en"
            messages={messages}
            now={NOW}
            timeZone="UTC"
          >
            <FormattingProvider locale="en" timeZone="UTC">
              <AuthenticatedUserProvider user={user}>
                <router.RouterProvider router={appRouter} />
              </AuthenticatedUserProvider>
            </FormattingProvider>
          </IntlProvider>
        </QueryClientProvider>
      </RenderLoopGuard>
    </AnalyticsContext>,
  );
  const navigateTo = async (next: ChatHistorySearch) => {
    await testing.act(async () => {
      setSearch(next);
    });
  };
  return { appRouter, navigateTo, searchChanges, ui };
};

/** A text field's value; an element that is not one reads as null. */
const inputValue = (element: Element) =>
  element instanceof HTMLInputElement ? element.value : null;

/** Clicks inside `act`, so dialog open/close transitions settle in order. */
const press = async (element: Element) => {
  await testing.act(async () => {
    testing.fireEvent.click(element);
  });
};

const threadLink = (ui: ReturnType<typeof testing.render>, title: string) =>
  ui.getByRole("link", { name: new RegExp(title, "u") });

const groupTitles = (ui: ReturnType<typeof testing.render>) =>
  ui
    .getAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent);

describe("chat history page", () => {
  test("groups chats by the reader's day and links each to its own route", async () => {
    serve(fullServer());
    const { ui } = await openHistory();

    await testing.waitFor(() =>
      expect(groupTitles(ui)).toEqual([
        messages.common.today,
        messages.chat.history.previous7Days,
        messages.chat.history.older,
      ]),
    );
    const sections = ui.getAllByRole("heading", { level: 2 }).map((heading) =>
      testing
        .within(heading.closest("section") ?? ui.container)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    );
    expect(sections).toEqual([
      [`/chat/${TODAY_GLOBAL.id}`],
      [`/chat/workspaces/${MATTER_A.id}/${THIS_WEEK_IN_A.id}`],
      [`/chat/workspaces/${MATTER_B.id}/${OLDER_IN_B.id}`],
    ]);
    expect(unexpected).toEqual([]);
  });

  test("search runs on the server after the reader pauses typing", async () => {
    serve(fullServer());
    const { searchChanges, ui } = await openHistory();
    await testing.waitFor(() =>
      expect(threadLink(ui, TODAY_GLOBAL.title)).toBeDefined(),
    );

    await testing.act(async () => {
      testing.fireEvent.change(
        ui.getByRole("searchbox", { name: messages.common.search }),
        { target: { value: "lease" } },
      );
    });

    expect(searchChanges).toEqual([]);
    expect(listRequests.map((url) => url.searchParams.get("search"))).toEqual([
      null,
    ]);
    await testing.waitFor(() =>
      expect(
        listRequests.map((url) => url.searchParams.get("search")),
      ).toContain("lease"),
    );
    expect(searchChanges).toEqual([{ q: "lease" }]);
    await testing.waitFor(() =>
      expect(ui.queryByText(TODAY_GLOBAL.title)).toBeNull(),
    );
    expect(threadLink(ui, OLDER_IN_B.title)).toBeDefined();
  });

  test("a matter filter keeps only the chats that live in that matter", async () => {
    serve(fullServer());
    const { ui } = await openHistory({ matter: MATTER_A.id });

    await testing.waitFor(() =>
      expect(threadLink(ui, THIS_WEEK_IN_A.title)).toBeDefined(),
    );
    expect(ui.queryByText(TODAY_GLOBAL.title)).toBeNull();
    expect(ui.queryByText(OLDER_IN_B.title)).toBeNull();
    // The field shows the matter the URL names.
    expect(
      inputValue(ui.getByRole("combobox", { name: messages.common.matter })),
    ).toBe(MATTER_A.name);
  });

  test("the matter filter reaches the server, so a matter chat past the first unfiltered page shows at once", async () => {
    // Unfiltered, the first page holds only the two newer, unrelated chats;
    // the matter's chat would sit on the second page.
    serve(fullServer(), { pageSize: 2 });
    const { ui } = await openHistory({ matter: MATTER_B.id });

    await testing.waitFor(() =>
      expect(threadLink(ui, OLDER_IN_B.title)).toBeDefined(),
    );
    expect(ui.queryByText(messages.common.noResults)).toBeNull();
    expect(
      ui.queryByRole("button", { name: messages.common.loadMore }),
    ).toBeNull();
    // The page asks the server for that matter's chats; the only unfiltered
    // read is the matter picker ranking its recent matters.
    expect(
      listRequests.filter(
        (url) => url.searchParams.get("workspaceId") === MATTER_B.id,
      ),
    ).toHaveLength(1);
    expect(
      listRequests.filter(
        (url) =>
          url.searchParams.get("workspaceId") !== MATTER_B.id &&
          url.searchParams.get("workspaceId") !== null,
      ),
    ).toEqual([]);
  });

  test("a matter the reader cannot open says so and offers to drop only that filter", async () => {
    serve(fullServer(), { matterStatus: 404 });
    const { searchChanges, ui } = await openHistory({
      matter: MATTER_A.id,
      q: "lease",
    });

    await testing.waitFor(() =>
      expect(
        ui.getByText(messages.chat.history.matterUnavailable),
      ).toBeDefined(),
    );
    expect(
      ui.queryByRole("button", { name: messages.common.retry }),
    ).toBeNull();
    expect(ui.queryByText(messages.common.somethingWentWrong)).toBeNull();

    await press(
      ui.getByRole("button", { name: messages.workspaces.filters.clear }),
    );

    // The search stays; only the matter goes.
    expect(searchChanges).toEqual([{ matter: undefined, q: "lease" }]);
    await testing.waitFor(() =>
      expect(threadLink(ui, OLDER_IN_B.title)).toBeDefined(),
    );
    expect(ui.queryByText(messages.chat.history.matterUnavailable)).toBeNull();
  });

  test("any other failure of a filtered read keeps the error and retry", async () => {
    serve(fullServer(), { matterStatus: 500 });
    const { ui } = await openHistory({ matter: MATTER_A.id });

    await testing.waitFor(() =>
      expect(ui.getByText(messages.common.somethingWentWrong)).toBeDefined(),
    );
    expect(
      ui.getByRole("button", { name: messages.common.retry }),
    ).toBeDefined();
    expect(ui.queryByText(messages.chat.history.matterUnavailable)).toBeNull();
  });

  test("navigating away mid-typing drops the typing's pending write", async () => {
    serve(fullServer());
    const { navigateTo, searchChanges, ui } = await openHistory();
    const field = ui.getByRole("searchbox", { name: messages.common.search });
    await testing.waitFor(() =>
      expect(threadLink(ui, TODAY_GLOBAL.title)).toBeDefined(),
    );

    jest.useFakeTimers();
    try {
      await testing.act(async () => {
        testing.fireEvent.change(field, { target: { value: "lease" } });
      });
      // The URL moves on before the typing's debounce fires.
      await navigateTo({ q: "claim" });
      await testing.act(async () => {
        jest.advanceTimersByTime(1000);
      });
    } finally {
      restoreRealTimers();
    }

    expect(inputValue(field)).toBe("claim");
    expect(searchChanges).toEqual([]);
    await testing.waitFor(() =>
      expect(threadLink(ui, THIS_WEEK_IN_A.title)).toBeDefined(),
    );
    expect(ui.queryByText(OLDER_IN_B.title)).toBeNull();
    expect(
      listRequests.map((url) => url.searchParams.get("search")),
    ).not.toContain("lease");
  });

  test("a query arriving from elsewhere replaces the search field's text", async () => {
    serve(fullServer());
    const { navigateTo, ui } = await openHistory({ q: "lease" });
    const field = ui.getByRole("searchbox", { name: messages.common.search });
    expect(inputValue(field)).toBe("lease");

    await navigateTo({ q: "claim" });

    expect(inputValue(field)).toBe("claim");
    await testing.waitFor(() =>
      expect(threadLink(ui, THIS_WEEK_IN_A.title)).toBeDefined(),
    );

    await navigateTo({});
    expect(inputValue(field)).toBe("");
  });

  test("clearing the filters brings every chat back", async () => {
    serve(fullServer());
    const { searchChanges, ui } = await openHistory({ matter: MATTER_A.id });
    await testing.waitFor(() =>
      expect(threadLink(ui, THIS_WEEK_IN_A.title)).toBeDefined(),
    );
    expect(ui.queryByText(TODAY_GLOBAL.title)).toBeNull();

    await press(ui.getByRole("button", { name: messages.common.clearFilters }));

    expect(searchChanges).toEqual([{}]);
    await testing.waitFor(() =>
      expect(threadLink(ui, TODAY_GLOBAL.title)).toBeDefined(),
    );
    expect(
      inputValue(ui.getByRole("combobox", { name: messages.common.matter })),
    ).toBe("");
  });

  test("deleting asks first, then removes the chat in its own scope", async () => {
    serve(fullServer());
    const { ui } = await openHistory();
    const row = await testing.waitFor(
      () => threadLink(ui, THIS_WEEK_IN_A.title).closest("li") ?? ui.container,
    );

    const deleteButton = testing
      .within(row)
      .getByRole("button", { name: messages.chat.deleteThread });
    await press(deleteButton);
    const dialog = ui.getByRole("alertdialog");
    expect(dialog.textContent).toContain(THIS_WEEK_IN_A.title);
    expect(deleteRequests).toEqual([]);

    await press(
      testing
        .within(dialog)
        .getByRole("button", { name: messages.common.cancel }),
    );
    expect(ui.queryByRole("alertdialog")).toBeNull();
    expect(deleteRequests).toEqual([]);

    await press(deleteButton);
    await press(
      testing
        .within(ui.getByRole("alertdialog"))
        .getByRole("button", { name: messages.common.delete }),
    );

    await testing.waitFor(() =>
      expect(ui.queryByText(THIS_WEEK_IN_A.title)).toBeNull(),
    );
    expect(
      deleteRequests.map((url) => [
        url.pathname.split("/").at(-1),
        url.searchParams.get("workspaceId"),
      ]),
    ).toEqual([[THIS_WEEK_IN_A.id, MATTER_A.id]]);
    expect(threadLink(ui, TODAY_GLOBAL.title)).toBeDefined();
  });

  test("each row is a link first, then its actions, in tab order", async () => {
    serve(fullServer());
    const { appRouter, ui } = await openHistory();
    const link = await testing.waitFor(() =>
      threadLink(ui, TODAY_GLOBAL.title),
    );
    const row = link.closest("li") ?? ui.container;
    const tabStops = [
      ...row.querySelectorAll<HTMLElement>("a[href], button"),
    ].filter((element) => element.tabIndex >= 0);

    expect(tabStops.at(0) === link).toBe(true);
    expect(
      tabStops.at(-1) ===
        testing
          .within(row)
          .getByRole("button", { name: messages.chat.deleteThread }),
    ).toBe(true);

    // A focused link activates on Enter with a click, as anchors do.
    link.focus();
    expect(document.activeElement === link).toBe(true);
    await press(link);
    await testing.waitFor(() =>
      expect(appRouter.state.location.pathname).toBe(
        `/chat/${TODAY_GLOBAL.id}`,
      ),
    );
  });

  test("with no chats at all, the empty state offers a new chat", async () => {
    serve({ global: [], workspaces: [] });
    const { ui } = await openHistory();

    await testing.waitFor(() =>
      expect(ui.getByText(messages.chat.noThreads)).toBeDefined(),
    );
    expect(
      ui
        .getByRole("link", { name: messages.chat.newChat })
        .getAttribute("href"),
    ).toBe("/chat");
  });

  test("a search with no matches says so and offers to clear it", async () => {
    serve(fullServer());
    const { searchChanges, ui } = await openHistory({ q: "arbitration" });

    await testing.waitFor(() =>
      expect(ui.getByText(messages.common.noResults)).toBeDefined(),
    );
    expect(ui.queryByText(messages.chat.noThreads)).toBeNull();
    const clearButtons = ui.getAllByRole("button", {
      name: messages.common.clearFilters,
    });
    await press(clearButtons.at(-1) ?? ui.container);
    expect(searchChanges).toEqual([{}]);
    await testing.waitFor(() =>
      expect(threadLink(ui, TODAY_GLOBAL.title)).toBeDefined(),
    );
  });
});
