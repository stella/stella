import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const router = await import("@tanstack/react-router");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const messages = (await import("@/i18n/langs/en.json")).default;
const { BilingualDocumentDialog } = await import("./bilingual-document-dialog");
const { stellaToast } = await import("@stll/ui/toast");

const originalFetch = globalThis.fetch;
const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  mock.restore();
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

test("bilingual document creation succeeds without an idempotency header", async () => {
  const toastAdd = spyOn(stellaToast, "add").mockImplementation(
    () => "success-toast",
  );
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const pathname = new URL(request.url).pathname;
      if (request.method === "POST" && pathname.endsWith("/bilingual")) {
        requests.push(request);
        return Response.json({
          entityId: "00000000-0000-4000-8000-000000000021",
          fieldId: "00000000-0000-4000-8000-000000000022",
          fileName: "Agreement (EN-FR).docx",
          rowCount: 2,
          warnings: [],
        });
      }
      if (pathname.startsWith("/api/auth/")) {
        return Response.json(null);
      }
      throw new TypeError(`Unexpected transport: ${pathname}`);
    },
    { preconnect: () => undefined },
  );

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const Page = () => (
    <BilingualDocumentDialog
      workspaceId="matter"
      entityId="entity"
      fieldId="field"
    />
  );
  const root = router.createRootRoute({ component: router.Outlet });
  const protectedRoute = router.createRoute({
    getParentRoute: () => root,
    id: "_protected",
    beforeLoad: () => ({ user: { activeOrganizationId: "organization-a" } }),
    component: router.Outlet,
  });
  const workspaceRoute = router.createRoute({
    getParentRoute: () => protectedRoute,
    path: "/workspaces/$workspaceId/$viewId",
    component: router.Outlet,
  });
  const documentRoute = router.createRoute({
    getParentRoute: () => workspaceRoute,
    path: "/document",
    component: Page,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({
      initialEntries: ["/workspaces/matter/view/document"],
    }),
    routeTree: root.addChildren([
      protectedRoute.addChildren([workspaceRoute.addChildren([documentRoute])]),
    ]),
    isServer: false,
  });
  await appRouter.load();
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <router.RouterProvider router={appRouter} />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

  fireEvent.click(
    screen.getByRole("button", { name: messages.bilingual.dialog.title }),
  );
  const createButton = screen.getByRole("button", {
    name: messages.bilingual.dialog.create,
  });
  expect(createButton.hasAttribute("disabled")).toBe(false);
  fireEvent.click(createButton);

  await waitFor(() => expect(requests).toHaveLength(1));
  expect(new URL(requests[0]?.url ?? "http://localhost").pathname).toBe(
    "/v1/entities/matter/bilingual",
  );
  expect(requests[0]?.method).toBe("POST");
  expect(requests[0]?.headers.has("Idempotency-Key")).toBe(false);
  await waitFor(() => expect(toastAdd).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
