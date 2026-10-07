import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { AvtView } = await import("./avt-view");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { legalListsOptions } =
  await import("@/lib/workspaces/queries/legal-lists");
const { roleOptions } = await import("@/lib/auth-queries");
const clients: InstanceType<typeof QueryClient>[] = [];
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("an empty matter offers a link to create lists in that matter", async () => {
  const workspaceId = "matter-with-no-lists";
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  clients.push(client);
  client.setQueryData(legalListsOptions(workspaceId).queryKey, { items: [] });
  client.setQueryData(roleOptions.queryKey, "owner");
  const root = createRootRoute({ component: Outlet });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <AvtView
        workspaceId={workspaceId}
        runId={undefined}
        onRunChange={() => undefined}
        view={{
          version: 1,
          id: "verification-view",
          name: "Verification",
          position: 0,
          createdAt: "2026-10-01T12:00:00Z",
          layout: {
            version: 1,
            type: "avt",
            filters: [],
            sorts: [],
            hiddenProperties: [],
            calculations: [],
            listId: null,
          },
        }}
      />
    ),
  });
  const lists = createRoute({
    getParentRoute: () => root,
    path: "/workspaces/$workspaceId/lists",
    component: () => <p>{messages.folio.listsGroup}</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([home, lists]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(
    <IntlProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </IntlProvider>,
  );
  expect(screen.getByText(messages.avt.view.noLists)).toBeTruthy();
  const action = screen.getByRole("link", {
    name: messages.avt.view.createList,
  });
  expect(action.getAttribute("href")).toBe(`/workspaces/${workspaceId}/lists`);
  fireEvent.click(action);
  await waitFor(() => {
    expect(router.state.location.pathname).toBe(
      `/workspaces/${workspaceId}/lists`,
    );
  });
  expect(await screen.findByText(messages.folio.listsGroup)).toBeTruthy();
});
