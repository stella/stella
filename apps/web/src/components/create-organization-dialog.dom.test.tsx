import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { CAPABILITY_REQUEST_HEADER } from "@stll/api-contract/capability-request";

import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/settings" });
Object.assign(globalThis, {
  __APP_VERSION__: "test",
  __APP_COMMIT_SHA__: "0000000000000000000000000000000000000000",
});
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { supportedLanguages } = await import("@/i18n/i18n-store");
const { CreateOrganizationDialog } =
  await import("./create-organization-dialog");
const { SidebarUserMenu } = await import("./sidebar-user-menu");
const { SidebarProvider, SidebarMenu } = await import("@stll/ui/sidebar");
const { roleOptions } = await import("@/lib/auth-queries");
const { organizationListOptions } = await import("@/lib/organization/queries");

const ORGANIZATION_ID = "019a0000-0000-7000-8000-000000000601";
const USER_ID = "019a0000-0000-7000-8000-000000000602";
const originalFetch = globalThis.fetch;
const requests: { path: string; body: unknown; capability: string | null }[] =
  [];
const clients: InstanceType<typeof QueryClient>[] = [];
const creationKeys: (string | null)[] = [];
let createOutcome: "created" | "refused" | "response-lost" = "created";
let switchOutcome: "switched" | "refused" = "switched";
let deferredCreate: Promise<Response> | undefined;

const createdResponse = () =>
  Response.json({
    organizationId: ORGANIZATION_ID,
    name: "New firm",
    slug: "new-firm",
    role: "owner",
  });

globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "POST") {
      requests.push({
        path,
        body: await request.json(),
        capability: request.headers.get(CAPABILITY_REQUEST_HEADER),
      });
    }
    if (path === "/v1/organizations" && request.method === "POST") {
      creationKeys.push(request.headers.get("Idempotency-Key"));
      if (createOutcome === "response-lost") {
        throw new TypeError("Creation response was lost");
      }
      if (deferredCreate) {
        return await deferredCreate;
      }
      return createOutcome === "created"
        ? createdResponse()
        : Response.json(
            {
              code: "organization_creation_refused",
              message: "Creation refused",
            },
            { status: 403 },
          );
    }
    if (path.endsWith("/organization/set-active")) {
      return switchOutcome === "switched"
        ? Response.json({
            id: ORGANIZATION_ID,
            name: "New firm",
            slug: "new-firm",
          })
        : Response.json(
            { code: "FORBIDDEN", message: "Switch refused" },
            { status: 403 },
          );
    }
    throw new TypeError(
      `Unexpected organization dialog request: ${request.method} ${path}`,
    );
  },
  { preconnect: originalFetch.preconnect },
);

afterEach(async () => {
  await act(async () => cleanup());
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  requests.length = 0;
  creationKeys.length = 0;
  createOutcome = "created";
  switchOutcome = "switched";
  deferredCreate = undefined;
  document.documentElement.dir = "ltr";
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const renderDialog = async (locale: "en" | "ar" = "en") => {
  const messages = locale === "ar" ? ar : en;
  document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  clients.push(queryClient);
  let closed = false;
  const root = createRootRoute();
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: () => (
      <CreateOrganizationDialog
        open
        userId={USER_ID}
        onOpenChange={(open) => {
          closed = !open;
        }}
      />
    ),
  });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <div>{messages.common.done}</div>,
  });
  const router = createRouter({
    routeTree: root.addChildren([settings, home]),
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale={locale} messages={messages} timeZone="UTC">
        <RouterProvider router={router} />
      </IntlProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("dialog", {
    name: messages.organization.newOrganization,
  });
  return { router, messages, wasClosed: () => closed };
};

test.each(
  supportedLanguages.filter((locale) => locale === "en" || locale === "ar"),
)(
  "the switcher dialog creates once and switches to its home in %s",
  async (locale) => {
    const { messages, wasClosed } = await renderDialog(locale);
    const response = Promise.withResolvers<Response>();
    deferredCreate = response.promise;
    const name = screen.getByRole("textbox", {
      name: messages.common.organizationName,
    });
    fireEvent.change(name, { target: { value: "  New firm  " } });
    const submit = screen.getByRole("button", {
      name: messages.auth.createOrganizationButton,
    });
    const form = submit.closest("form");
    if (!form) {
      throw new TypeError(
        "The organization submit button must belong to a form",
      );
    }
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() =>
      expect(
        requests.filter(({ path }) => path === "/v1/organizations"),
      ).toHaveLength(1),
    );
    expect(submit.hasAttribute("disabled")).toBe(true);
    response.resolve(createdResponse());
    expect(await screen.findByText(messages.common.done)).toBeTruthy();
    expect(requests).toEqual([
      {
        path: "/v1/organizations",
        body: { name: "New firm" },
        capability: "organizations.create",
      },
      {
        path: "/api/auth/organization/set-active",
        body: { organizationId: ORGANIZATION_ID },
        capability: null,
      },
    ]);
    expect(creationKeys.at(0)).toBeTruthy();
    expect(wasClosed()).toBe(true);
  },
);

test("a refused creation keeps the dialog open and permits retry", async () => {
  createOutcome = "refused";
  const { messages } = await renderDialog();
  fireEvent.change(
    screen.getByRole("textbox", { name: messages.common.organizationName }),
    { target: { value: "New firm" } },
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.auth.createOrganizationButton,
    }),
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(requests).toHaveLength(1);
  createOutcome = "created";
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.auth.createOrganizationButton,
    }),
  );
  expect(await screen.findByText(messages.common.done)).toBeTruthy();
});

test("retry after a refused switch reuses the created organization", async () => {
  switchOutcome = "refused";
  const { messages } = await renderDialog();
  fireEvent.change(
    screen.getByRole("textbox", { name: messages.common.organizationName }),
    { target: { value: "New firm" } },
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.auth.createOrganizationButton,
    }),
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  switchOutcome = "switched";
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.organization.switchOrganization,
    }),
  );
  expect(await screen.findByText(messages.common.done)).toBeTruthy();
  expect(
    requests.filter(({ path }) => path === "/v1/organizations"),
  ).toHaveLength(1);
});

test("the sidebar organization switcher opens the new organization dialog", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(roleOptions.queryKey, "owner");
  queryClient.setQueryData(organizationListOptions(USER_ID).queryKey, [
    {
      id: ORGANIZATION_ID,
      name: "Original firm",
      slug: "original-firm",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      logo: null,
    },
  ]);
  const root = createRootRoute();
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: () => (
      <SidebarProvider defaultOpen>
        <SidebarMenu>
          <SidebarUserMenu
            user={{
              activeOrganizationId: ORGANIZATION_ID,
              email: "member@example.test",
              id: USER_ID,
              image: null,
              name: "Test member",
            }}
          />
        </SidebarMenu>
      </SidebarProvider>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([settings]),
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <RouterProvider router={router} />
      </IntlProvider>
    </QueryClientProvider>,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: /Test member/u }));
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: en.organization.newOrganization,
    }),
  );
  expect(
    await screen.findByRole("dialog", {
      name: en.organization.newOrganization,
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole("textbox", { name: en.common.organizationName }),
  ).toBeTruthy();
  expect(requests).toEqual([]);
});

test("retry after a lost creation response retains the same replay key", async () => {
  createOutcome = "response-lost";
  const { messages } = await renderDialog();
  fireEvent.change(
    screen.getByRole("textbox", { name: messages.common.organizationName }),
    { target: { value: "New firm" } },
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.auth.createOrganizationButton,
    }),
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  createOutcome = "created";
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.auth.createOrganizationButton,
    }),
  );
  expect(await screen.findByText(messages.common.done)).toBeTruthy();
  expect(creationKeys).toHaveLength(2);
  expect(creationKeys.at(0)).toBeTruthy();
  expect(creationKeys.at(1)).toBe(creationKeys.at(0));
});
