import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { WebApiRoutes } from "@/lib/api";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });
const previousFetch = globalThis.fetch;

const testing = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { noopAnalytics } = await import("@/lib/analytics/noop");
const { Breadcrumb, BreadcrumbList } = await import("@stll/ui/breadcrumb");
const { ChatBreadcrumb } = await import("./chat-breadcrumb");

type ThreadsPage = WebApiRoutes["chat"]["threads"]["get"]["response"][200];
type ThreadSlice = ThreadsPage["global"][number];

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

const thread = (id: string, title: string, updatedAt: string): ThreadSlice => ({
  context: { fileCount: 0, files: [], matterCount: 0, matters: [] },
  createdAt: updatedAt,
  decision: null,
  id,
  origin: "original",
  pinState: "unpinned",
  readState: "read",
  title,
  updatedAt,
  usedAnonymization: false,
});

const CURRENT = thread(
  "00000000-0000-7000-8000-000000000001",
  "Limitation period for unpaid invoices",
  "2026-10-11T09:00:00.000Z",
);
const OTHER = thread(
  "00000000-0000-7000-8000-000000000002",
  "Termination notice for the lease",
  "2026-10-10T09:00:00.000Z",
);
const IN_MATTER = thread(
  "00000000-0000-7000-8000-000000000003",
  "Draft statement of claim",
  "2026-10-09T09:00:00.000Z",
);
const MATTER = {
  workspaceId: "00000000-0000-7000-8000-0000000000a1",
  workspaceName: "Novak v. Horak",
};

const listRequests: URL[] = [];
const unexpected: string[] = [];

/** The member's chats as the history lists them, filtered by `search`. */
const serve = (older: ThreadSlice[] = []) => {
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/chat/threads") && request.method === "GET") {
        listRequests.push(url);
        const search = url.searchParams.get("search")?.toLowerCase() ?? "";
        const matches = (slice: ThreadSlice) =>
          slice.title.toLowerCase().includes(search);
        return Response.json({
          global: [CURRENT, OTHER, ...older].filter(matches),
          nextCursor: null,
          workspaces: [
            { ...MATTER, threads: [IN_MATTER].filter(matches) },
          ].filter(({ threads }) => threads.length > 0),
        } satisfies ThreadsPage);
      }
      if (url.pathname.endsWith("/workspaces/navigation")) {
        return Response.json({ workspaces: [], features: {} });
      }
      unexpected.push(`${request.method} ${url.pathname}`);
      return Response.json({ message: "unexpected" }, { status: 500 });
    },
    { preconnect: previousFetch.preconnect },
  );
};

const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  testing.cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  listRequests.length = 0;
  unexpected.length = 0;
  globalThis.fetch = previousFetch;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

/** The chat crumb in the app trail, on the current chat's route. */
const openCrumb = async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  const root = router.createRootRoute({ component: router.Outlet });
  const crumb = () => {
    const threadId = router.useParams({
      strict: false,
      select: (params) => params.threadId,
    });
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ChatBreadcrumb threadId={threadId ?? ""} />
        </BreadcrumbList>
      </Breadcrumb>
    );
  };
  const routes = [
    "/chat/$threadId",
    "/chat/history",
    "/chat/workspaces/$workspaceId/$threadId",
  ].map((path) =>
    router.createRoute({
      getParentRoute: () => root,
      path,
      component: crumb,
    }),
  );
  const appRouter = router.createRouter({
    routeTree: root.addChildren(routes),
    history: router.createMemoryHistory({
      initialEntries: [`/chat/${CURRENT.id}`],
    }),
    isServer: false,
  });
  await appRouter.load();
  const ui = testing.render(
    <AnalyticsContext value={noopAnalytics}>
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <AuthenticatedUserProvider user={user}>
              <router.RouterProvider router={appRouter} />
            </AuthenticatedUserProvider>
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>
    </AnalyticsContext>,
  );
  await ui.findByText(CURRENT.title);
  return { ui, appRouter };
};

const openSwitcher = async (ui: ReturnType<typeof testing.render>) => {
  const trigger = await ui.findByRole("button", {
    name: messages.chat.switcher.trigger,
  });
  await testing.act(async () => {
    testing.fireEvent.click(trigger);
  });
  await testing.waitFor(() =>
    expect(ui.queryAllByRole("option").length > 0).toBe(true),
  );
};

/** The switcher's rows by their text, in order. */
const optionTexts = (ui: ReturnType<typeof testing.render>) =>
  ui.queryAllByRole("option").map((option) => option.textContent);

test("the chat title is the trail's current page, in the foreground colour every last crumb has", async () => {
  serve();
  const { ui } = await openCrumb();

  const page = ui.getByText(CURRENT.title).closest("[aria-current='page']");
  expect(page?.dataset.slot).toBe("breadcrumb-page");
  expect(page?.className.split(" ").includes("text-foreground")).toBe(true);
  expect(unexpected).toEqual([]);
});

test("the switcher lists the member's recent chats, the current one marked, then All chats", async () => {
  serve();
  const { ui } = await openCrumb();
  await openSwitcher(ui);

  expect(optionTexts(ui)).toEqual([
    CURRENT.title,
    OTHER.title,
    `${IN_MATTER.title}${MATTER.workspaceName}`,
    messages.chat.switcher.allChats,
  ]);
  const current = ui
    .getAllByRole("option")
    .find((option) => option.getAttribute("aria-current") === "page");
  expect(current?.textContent).toBe(CURRENT.title);
  // The same scope as the history: every chat of the member, unfiltered.
  expect(listRequests.at(-1)?.searchParams.get("pinState")).toBeNull();
  expect(unexpected).toEqual([]);
});

test("the switcher keeps to the most recent chats, so All chats stays in view", async () => {
  serve(
    Array.from({ length: 10 }, (_, index) =>
      thread(
        `00000000-0000-7000-8000-0000000001${String(index).padStart(2, "0")}`,
        `Older chat ${String(index + 1)}`,
        `2026-09-${String(20 - index).padStart(2, "0")}T09:00:00.000Z`,
      ),
    ),
  );
  const { ui } = await openCrumb();
  await openSwitcher(ui);

  const texts = optionTexts(ui);
  expect(texts).toHaveLength(9);
  expect(texts.slice(0, 2)).toEqual([CURRENT.title, OTHER.title]);
  expect(texts.at(-1)).toBe(messages.chat.switcher.allChats);
});

test("typing in the switcher searches the chats, and choosing one opens it", async () => {
  serve();
  const { ui, appRouter } = await openCrumb();
  await openSwitcher(ui);

  await testing.act(async () => {
    testing.fireEvent.change(
      ui.getByPlaceholderText(messages.chat.switcher.searchPlaceholder),
      { target: { value: "lease" } },
    );
  });
  await testing.waitFor(() =>
    expect(optionTexts(ui)).toEqual([
      OTHER.title,
      messages.chat.switcher.allChats,
    ]),
  );
  expect(listRequests.at(-1)?.searchParams.get("search")).toBe("lease");

  const other = ui
    .getAllByRole("option")
    .find((option) => option.textContent === OTHER.title);
  if (other === undefined) {
    throw new Error("Expected the searched chat in the switcher");
  }
  await testing.act(async () => {
    testing.fireEvent.click(other);
  });
  await testing.waitFor(() =>
    expect(appRouter.state.location.pathname).toBe(`/chat/${OTHER.id}`),
  );
  expect(unexpected).toEqual([]);
});

test("the keyboard walks the switcher and Enter opens the chat in its matter", async () => {
  serve();
  const { ui, appRouter } = await openCrumb();
  await openSwitcher(ui);

  const input = ui.getByPlaceholderText(
    messages.chat.switcher.searchPlaceholder,
  );
  for (const _ of [CURRENT, OTHER, IN_MATTER].slice(1)) {
    await testing.act(async () => {
      testing.fireEvent.keyDown(input, { key: "ArrowDown" });
    });
  }
  await testing.act(async () => {
    testing.fireEvent.keyDown(input, { key: "Enter" });
  });
  await testing.waitFor(() =>
    expect(appRouter.state.location.pathname).toBe(
      `/chat/workspaces/${MATTER.workspaceId}/${IN_MATTER.id}`,
    ),
  );
});

test("All chats opens the full chat history", async () => {
  serve();
  const { ui, appRouter } = await openCrumb();
  await openSwitcher(ui);

  const all = ui
    .getAllByRole("option")
    .find((option) => option.textContent === messages.chat.switcher.allChats);
  if (all === undefined) {
    throw new Error("Expected All chats in the switcher");
  }
  await testing.act(async () => {
    testing.fireEvent.click(all);
  });
  await testing.waitFor(() =>
    expect(appRouter.state.location.pathname).toBe("/chat/history"),
  );
});
