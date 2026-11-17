import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/onboarding" });
const originalFetch = globalThis.fetch;
const cobe = await import("cobe");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { stellaToast } = await import("@stll/ui/toast");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const messages = (await import("@/i18n/langs/en.json")).default;
const { MEMBER_SESSION } =
  await import("@/lib/account/auth-session.test-fixtures");
const { sessionOptions } = await import("@/lib/auth-queries");
const { nativeToolDeployAvailabilityOptions } = await import("../-queries");
const { OnboardingWizard } = await import("./onboarding-wizard");

const clients: InstanceType<typeof QueryClient>[] = [];
beforeEach(() => {
  // The DOM fixture exercises the wizard and transport, not its WebGL decoration.
  spyOn(cobe, "default").mockImplementation(() => ({
    update: () => undefined,
    destroy: () => undefined,
  }));
});
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  globalThis.fetch = originalFetch;
  mock.restore();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

test("a failed post-create refresh preserves configuration submission and reaches recovery once", async () => {
  const writes: { path: string; body: unknown }[] = [];
  let created = false;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "POST" || request.method === "PATCH") {
        writes.push({ path: url.pathname, body: await request.json() });
      }
      if (
        url.pathname.endsWith("/organizations") &&
        request.method === "POST"
      ) {
        created = true;
        return Response.json({
          organizationId: "org-created",
          name: "Practice team",
          slug: "practice-team",
          role: "owner",
          nextCall: {
            command: "stella auth login",
            instruction: "Continue setup",
          },
        });
      }
      if (url.pathname.endsWith("/set-active")) {
        return Response.json({ id: "org-created" });
      }
      if (url.pathname.endsWith("/get-session")) {
        return created
          ? Response.json(
              {
                code: "INTERNAL_SERVER_ERROR",
                message: "Session could not be read",
              },
              { status: 503 },
            )
          : Response.json({
              ...MEMBER_SESSION,
              session: {
                ...MEMBER_SESSION.session,
                activeOrganizationId: null,
              },
              user: { ...MEMBER_SESSION.user, detectedCountry: "CZ" },
            });
      }
      if (url.pathname.endsWith("/practice-jurisdictions")) {
        return Response.json({ success: true });
      }
      if (
        /\/mcp\/native-tools\/[^/]+$/u.test(url.pathname) &&
        request.method === "PATCH"
      ) {
        return Response.json({ success: true });
      }
      if (url.pathname.endsWith("/invite-member")) {
        return Response.json({
          id: "invitation-a",
          organizationId: "org-created",
          inviterId: MEMBER_SESSION.user.id,
          email: "colleague@example.test",
          role: "member",
          status: "pending",
          expiresAt: MEMBER_SESSION.session.expiresAt,
        });
      }
      throw new Error(
        `Unexpected onboarding request: ${request.method} ${url.pathname}`,
      );
    },
    { preconnect: () => undefined },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  await client.query(sessionOptions);
  client.setQueryData(nativeToolDeployAvailabilityOptions.queryKey, {
    unavailableNativeToolBackendSlugs: [],
  });
  const root = router.createRootRoute();
  const page = router.createRoute({
    getParentRoute: () => root,
    path: "/onboarding",
    component: OnboardingWizard,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/onboarding"] }),
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
    fireEvent.change(
      await ui.findByPlaceholderText(messages.onboarding.orgNamePlaceholder),
      {
        target: { value: "Practice team" },
      },
    );
    fireEvent.click(ui.getByRole("button", { name: messages.common.next }));
    await ui.findByRole("heading", {
      name: messages.onboarding.jurisdictionTitle,
    });
    fireEvent.click(ui.getByRole("button", { name: messages.common.next }));
    await ui.findByRole("heading", {
      name: messages.onboarding.catalogueTitle,
    });
    fireEvent.click(
      ui.getByRole("button", {
        name: messages.onboarding.skipStep,
      }),
    );
    await ui.findByRole("heading", { name: messages.onboarding.aiTitle });
    fireEvent.click(
      ui.getByRole("button", {
        name: messages.onboarding.skipStep,
      }),
    );
    await ui.findByRole("heading", { name: messages.onboarding.inviteTitle });
    fireEvent.change(ui.getByPlaceholderText("colleague@example.com"), {
      target: { value: "colleague@example.test" },
    });
    fireEvent.click(ui.getByRole("button", { name: messages.common.next }));
    await ui.findByRole("heading", { name: messages.onboarding.appsTitle });
    await waitFor(() => expect(notice).toHaveBeenCalledTimes(1));
    expect(
      writes.filter(({ path }) => path.endsWith("/organizations")),
    ).toHaveLength(1);
    expect(
      writes.find(({ path }) => path.endsWith("/practice-jurisdictions"))?.body,
    ).toEqual({
      practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
    });
    expect(
      writes.find(({ path }) => path.endsWith("/invite-member"))?.body,
    ).toMatchObject({
      email: "colleague@example.test",
      role: "member",
    });
    expect(
      ui.queryByPlaceholderText(messages.onboarding.orgNamePlaceholder),
    ).toBeNull();
    expect(appRouter.state.location.pathname).toBe("/onboarding");
    expect(notice).toHaveBeenCalledTimes(1);
  } finally {
    notice.mockRestore();
  }
});
