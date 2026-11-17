import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { deferred } from "@stll/test-kit";

GlobalRegistrator.register({ url: "http://localhost:3000/consent" });
const originalFetch = globalThis.fetch;
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { stellaToast } = await import("@stll/ui/toast");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const messages = (await import("@/i18n/langs/en.json")).default;
const { MEMBER_SESSION } =
  await import("@/lib/account/auth-session.test-fixtures");
const { roleOptions, sessionOptions } = await import("@/lib/auth-queries");
const { organizationListOptions } = await import("@/lib/organization/queries");
const { Route } = await import("./consent");

const clients: InstanceType<typeof QueryClient>[] = [];
let heldSession: ReturnType<typeof deferred<Response>> | undefined;

afterEach(() => {
  heldSession?.resolve(Response.json(null));
  heldSession = undefined;
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

test("an organization switch with a failed confirmation read leaves pending and reports once", async () => {
  const switched: string[] = [];
  const response = deferred<Response>();
  const reached = deferred<undefined>();
  heldSession = response;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/get-active-member-role")) {
        return Response.json({ role: "member" });
      }
      if (url.pathname.endsWith("/set-active")) {
        switched.push(await new Request(input, init).text());
        return Response.json({ id: "org-other" });
      }
      if (url.pathname.endsWith("/get-session")) {
        reached.resolve(undefined);
        return await response.promise;
      }
      throw new Error(`Unexpected consent request: ${url.pathname}`);
    },
    { preconnect: () => undefined },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  client.setQueryData(
    organizationListOptions(MEMBER_SESSION.user.id).queryKey,
    [
      {
        id: "org_1",
        name: "First organization",
        slug: "first",
        createdAt: MEMBER_SESSION.session.createdAt,
      },
      {
        id: "org-other",
        name: "Other organization",
        slug: "other",
        createdAt: MEMBER_SESSION.session.createdAt,
      },
    ],
  );
  await client.query(roleOptions);
  const Component = Route.options.component;
  if (Component === undefined) {
    throw new Error("Consent must declare its page component");
  }
  const root = router.createRootRoute();
  const page = router.createRoute({
    getParentRoute: () => root,
    path: "/consent",
    beforeLoad: () => ({
      session: MEMBER_SESSION.session,
      user: MEMBER_SESSION.user,
      userId: MEMBER_SESSION.user.id,
    }),
    component: Component,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/consent"] }),
    routeTree: root.addChildren([page]),
    isServer: false,
  });
  await appRouter.load();
  const notice = spyOn(stellaToast, "add").mockImplementation(() => "notice");
  try {
    const ui = render(
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages}>
          <FormattingProvider locale="en" timeZone="UTC">
            <router.RouterProvider router={appRouter} />
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>,
    );
    const picker = await ui.findByRole("combobox", {
      name: messages.organization.switchOrganization,
    });
    await act(async () => fireEvent.click(picker));
    const option = await ui.findByRole("option", {
      name: "Other organization",
    });
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.click(option);
    });
    await reached.promise;
    expect(picker.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      response.resolve(
        Response.json(
          {
            code: "INTERNAL_SERVER_ERROR",
            message: "Session could not be read",
          },
          { status: 503 },
        ),
      );
    });
    await ui.findByText(messages.consent.error);
    await waitFor(() => expect(picker.hasAttribute("disabled")).toBe(false));
    expect(switched).toHaveLength(1);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(appRouter.state.location.pathname).toBe("/consent");
  } finally {
    notice.mockRestore();
  }
});
