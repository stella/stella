import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, jest, test } from "bun:test";

import type { contactsOptions } from "@/lib/contacts/queries";
import { toSafeId } from "@/lib/safe-id";

GlobalRegistrator.register({ url: "http://localhost:3000/contacts" });
const originalFetch = globalThis.fetch;
let failing = true;
let empty = false;
let heldRead: ReturnType<typeof Promise.withResolvers<Response>> | undefined;
const capturedErrors: unknown[] = [];
const reads: URL[] = [];
type ContactListResponse = Awaited<
  ReturnType<NonNullable<ReturnType<typeof contactsOptions>["queryFn"]>>
>;
const match = {
  id: toSafeId<"contact">("00000000-0000-4000-8000-000000000001"),
  type: "person",
  displayName: "Eva Novak",
  color: null,
  emails: [],
  phones: [],
  firstName: "Eva",
  lastName: "Novak",
  organizationName: null,
  tags: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  clientMatterCount: 0,
} satisfies ContactListResponse["items"][number];
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname.endsWith("/mcp/connectors")) {
      return Response.json({ nativeTools: [], connectors: [] });
    }
    if (
      !url.pathname.endsWith("/contacts") &&
      !url.pathname.endsWith("/contacts/search")
    ) {
      throw new TypeError(`Unexpected contact test request: ${url.pathname}`);
    }
    reads.push(url);
    if (heldRead) {
      return await heldRead.promise;
    }
    return failing
      ? Response.json({ message: "Unavailable" }, { status: 503 })
      : Response.json({ items: empty ? [] : [match], nextCursor: null });
  },
  { preconnect: () => undefined },
);

const testing = await import("@testing-library/react");
const query = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { ContactPicker } = await import("@/components/contact-picker");
const { Route } = await import("@/routes/_protected.contacts/index");
const ContactsPage = () => {
  const Component = Route.options.component;
  if (!Component) {
    throw new TypeError("Contacts route must declare a component");
  }
  return <Component />;
};
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { noopAnalytics } = await import("@/lib/analytics/noop");
const { rootKeys } = await import("@/lib/auth-queries");
const { contactsKeys } = await import("@/lib/contacts/queries");
const { contactPickerKeys } =
  await import("@/components/contact-picker-queries");
const ORGANIZATION = "contact-search-org";
const clients: InstanceType<typeof query.QueryClient>[] = [];
const user = {
  activeOrganizationId: ORGANIZATION,
  id: "reader",
  email: "reader@example.test",
  image: null,
  name: undefined,
  preferredName: null,
  timezoneId: "Europe/Prague",
  wordEditShortcut: null,
};

afterEach(() => {
  testing.cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  reads.length = 0;
  failing = true;
  empty = false;
  heldRead = undefined;
  capturedErrors.length = 0;
  jest.useRealTimers();
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

const mount = async (picker = false, locale: "en" | "ar" = "en") => {
  const client = new query.QueryClient({
    defaultOptions: {
      queries: { retry: 1, retryDelay: 0, staleTime: Infinity },
    },
  });
  clients.push(client);
  client.setQueryData(rootKeys.role, "owner");
  const root = router.createRootRoute({ component: router.Outlet });
  const protectedRoute = router.createRoute({
    getParentRoute: () => root,
    id: "_protected",
    beforeLoad: () => ({ user }),
  });
  const page = router.createRoute({
    getParentRoute: () => protectedRoute,
    path: "/contacts",
    component: picker
      ? () => (
          <ContactPicker
            onCreate={() => undefined}
            onSelect={() => undefined}
          />
        )
      : ContactsPage,
  });
  const appRouter = router.createRouter({
    routeTree: root.addChildren([protectedRoute.addChildren([page])]),
    history: router.createMemoryHistory({ initialEntries: ["/contacts"] }),
    isServer: false,
  });
  await appRouter.load();
  const catalog =
    locale === "en" ? messages : (await import("@/i18n/langs/ar.json")).default;
  testing.render(
    <AnalyticsContext
      value={{
        ...noopAnalytics,
        captureError: (error) => {
          capturedErrors.push(error);
        },
      }}
    >
      <query.QueryClientProvider client={client}>
        <IntlProvider
          locale={locale}
          messages={catalog}
          timeZone="Europe/Prague"
        >
          <FormattingProvider locale={locale} timeZone="Europe/Prague">
            <AuthenticatedUserProvider user={user}>
              <router.RouterProvider router={appRouter} />
            </AuthenticatedUserProvider>
          </FormattingProvider>
        </IntlProvider>
      </query.QueryClientProvider>
    </AnalyticsContext>,
  );
  return client;
};

const expectReadError = async () => {
  await testing.waitFor(() =>
    expect(testing.screen.getByRole("alert")).toBeTruthy(),
  );
  expect(
    testing.screen.queryByText(messages.contacts.noContactsFound),
  ).toBeNull();
  expect(testing.screen.queryByText(messages.contacts.emptyTitle)).toBeNull();
  expect(capturedErrors.length).toBeGreaterThan(0);
};

const typeSearch = async (input: HTMLElement) => {
  jest.useFakeTimers();
  testing.fireEvent.input(input, {
    target: { value: "Eva" },
    inputType: "insertText",
  });
  await testing.act(async () => {
    jest.advanceTimersByTime(301);
  });
  await testing.act(async () => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });
};

test("contacts filtered search offers recovery and authoritative empty results", async () => {
  const client = await mount();
  await typeSearch(
    testing.screen.getByPlaceholderText(messages.contacts.search),
  );
  testing.fireEvent.click(
    testing.screen.getByRole("button", {
      name: messages.contacts.filterPersons,
    }),
  );
  await testing.waitFor(() =>
    expect(
      reads.some(
        (url) =>
          url.searchParams.get("q") === "Eva" &&
          url.searchParams.get("type") === "person",
      ),
    ).toBe(true),
  );
  await expectReadError();
  failing = false;
  testing.fireEvent.click(
    testing.screen.getByRole("button", { name: messages.common.retry }),
  );
  await testing.waitFor(() =>
    expect(testing.screen.getByText(match.displayName)).toBeTruthy(),
  );
  empty = true;
  await testing.act(async () => {
    await client.invalidateQueries({
      queryKey: contactsKeys.lists(ORGANIZATION),
    });
  });
  await testing.waitFor(() =>
    expect(
      testing.screen.getByText(messages.contacts.noContactsFound),
    ).toBeTruthy(),
  );
});

test("contacts failed refresh retains authoritative rows with recovery", async () => {
  failing = false;
  const client = await mount();
  await testing.waitFor(() =>
    expect(testing.screen.getByText(match.displayName)).toBeTruthy(),
  );
  failing = true;
  await testing.act(async () => {
    await client.invalidateQueries({
      queryKey: contactsKeys.lists(ORGANIZATION),
    });
  });
  await expectReadError();
  expect(testing.screen.getByText(match.displayName)).toBeTruthy();
});

test("picker failed search hides creation and recovers matches while retaining failed refresh data", async () => {
  const client = await mount(true);
  const input = testing.screen.getByRole("combobox");
  if (!(input instanceof HTMLInputElement)) {
    throw new TypeError("Expected contact search input");
  }
  testing.act(() => input.focus());
  await typeSearch(input);
  expect(input.value).toBe("Eva");
  await testing.waitFor(() =>
    expect(
      reads.some(
        (url) =>
          url.pathname.endsWith("/contacts/search") &&
          url.searchParams.get("q") === "Eva",
      ),
    ).toBe(true),
  );
  await expectReadError();
  expect(testing.screen.queryAllByRole("option")).toHaveLength(0);
  failing = false;
  testing.fireEvent.click(
    testing.screen.getByRole("button", { name: messages.common.retry }),
  );
  await testing.waitFor(() =>
    expect(testing.screen.getByText(match.displayName)).toBeTruthy(),
  );
  failing = true;
  await testing.act(async () => {
    await client.invalidateQueries({
      queryKey: contactPickerKeys.byOrganization({
        organizationId: ORGANIZATION,
      }),
    });
  });
  await expectReadError();
  expect(testing.screen.getByText(match.displayName)).toBeTruthy();
  expect(testing.screen.getAllByRole("option")).toHaveLength(1);
});

test("contacts initial failed read offers retry rather than first use", async () => {
  await mount();
  await expectReadError();
  expect(
    testing.screen.getByRole("button", { name: messages.common.retry }),
  ).toBeTruthy();
});

test("picker pending read hides creation and only successful absence is empty", async () => {
  const pending = Promise.withResolvers<Response>();
  heldRead = pending;
  await mount(true);
  const input = testing.screen.getByRole("combobox");
  if (!(input instanceof HTMLInputElement)) {
    throw new TypeError("Expected contact search input");
  }
  testing.act(() => input.focus());
  jest.useFakeTimers();
  testing.fireEvent.input(input, {
    target: { value: "Eva" },
    inputType: "insertText",
  });
  expect(testing.screen.queryAllByRole("option")).toHaveLength(0);
  await testing.act(async () => {
    jest.advanceTimersByTime(201);
  });
  await testing.act(async () => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });
  await testing.waitFor(() =>
    expect(reads.some((url) => url.searchParams.get("q") === "Eva")).toBe(true),
  );
  expect(testing.screen.queryAllByRole("option")).toHaveLength(0);
  expect(
    testing.screen.queryByText(messages.contacts.noContactsFound),
  ).toBeNull();
  await testing.act(async () =>
    pending.resolve(Response.json({ items: [], nextCursor: null })),
  );
  await testing.waitFor(() =>
    expect(testing.screen.getAllByRole("option")).toHaveLength(2),
  );
});

test("contact recovery uses the Arabic catalog", async () => {
  const { default: arabic } = await import("@/i18n/langs/ar.json");
  await mount(false, "ar");
  await testing.waitFor(() =>
    expect(testing.screen.getByRole("alert")).toBeTruthy(),
  );
  expect(
    testing.screen.getByRole("button", { name: arabic.common.retry }),
  ).toBeTruthy();
  expect(testing.screen.getByText(arabic.errors.actionFailed)).toBeTruthy();
  expect(
    testing.screen.queryByText(arabic.contacts.noContactsFound),
  ).toBeNull();
});

test("successful empty contact reads retain recovery after a failed refresh", async () => {
  failing = false;
  empty = true;
  const client = await mount();
  await testing.waitFor(() =>
    expect(testing.screen.getByText(messages.contacts.emptyTitle)).toBeTruthy(),
  );
  failing = true;
  await testing.act(async () => {
    await client.invalidateQueries({
      queryKey: contactsKeys.lists(ORGANIZATION),
    });
  });
  await expectReadError();
});

test("picker successful empty search hides creation after failed refresh", async () => {
  failing = false;
  empty = true;
  const client = await mount(true);
  const input = testing.screen.getByRole("combobox");
  if (!(input instanceof HTMLInputElement)) {
    throw new TypeError("Expected contact search input");
  }
  testing.act(() => input.focus());
  await typeSearch(input);
  await testing.waitFor(() =>
    expect(testing.screen.getAllByRole("option")).toHaveLength(2),
  );
  failing = true;
  await testing.act(async () => {
    await client.invalidateQueries({
      queryKey: contactPickerKeys.byOrganization({
        organizationId: ORGANIZATION,
      }),
    });
  });
  await expectReadError();
  expect(testing.screen.queryAllByRole("option")).toHaveLength(0);
});
