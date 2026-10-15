import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { QueryClient as Client } from "@tanstack/react-query";
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { cents } from "@stll/money";
import { assertProperty } from "@stll/property-testing";

import type { ContactUpdate } from "@/lib/contacts/mutations";
import type { ContactData } from "@/routes/_protected.contacts/-components/types";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/contacts/a" });

const originalFetch = globalThis.fetch;
type PendingPost = {
  url: string;
  body: Record<string, unknown>;
  response: ReturnType<typeof Promise.withResolvers<Response>>;
};
const posts: PendingPost[] = [];
const serverContacts = new Map<string, ContactData>();
const heldContactReads = new Map<
  string,
  {
    requested: ReturnType<typeof Promise.withResolvers<undefined>>;
    response: ReturnType<typeof Promise.withResolvers<Response>>;
  }
>();
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "GET") {
      const id = new URL(request.url).pathname.split("/").at(-1);
      const held = id ? heldContactReads.get(id) : undefined;
      if (held) {
        held.requested.resolve(undefined);
        return await held.response.promise;
      }
      const data = id ? serverContacts.get(id) : undefined;
      if (data) {
        return Response.json(data);
      }
    }
    if (request.method !== "POST") {
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    }
    const response = Promise.withResolvers<Response>();
    posts.push({
      url: request.url,
      body: v.parse(v.record(v.string(), v.unknown()), await request.json()),
      response,
    });
    return await response.promise;
  },
  { preconnect: () => undefined },
);

const testing = await import("@testing-library/react");
const query = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { Route: contactRoute } =
  await import("@/routes/_protected.contacts/$contactId");
const { Input } = await import("@stll/ui/input");
const { stellaToast } = await import("@stll/ui/toast");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { rootKeys } = await import("@/lib/auth-queries");
const { organizationKeys } = await import("@/lib/organization/queries");
const { Route: invoiceRoute } =
  await import("@/routes/_protected.workspaces/$workspaceId/invoices/$invoiceId");
const { ContactNotesEditor } =
  await import("@/routes/_protected.contacts/-components/contact-notes-editor");
const { EditableRow } =
  await import("@/routes/_protected.contacts/-components/editable-row");
const { ContactCommunicationEditor } =
  await import("@/routes/_protected.contacts/-components/contact-communication-editor");
const { ContactCustomFieldsEditor } =
  await import("@/routes/_protected.contacts/-components/contact-custom-fields-editor");
const { useUpdateContact } = await import("@/lib/contacts/mutations");
const { contactOptions, contactsKeys } = await import("@/lib/contacts/queries");
const { contactPickerKeys } =
  await import("@/components/contact-picker-queries");
const { workspacesKeys } = await import("@/lib/workspaces/queries");
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { noopAnalytics } = await import("@/lib/analytics/noop");
const { toSafeId } = await import("@/lib/safe-id");

const ORGANIZATION = toSafeId<"organization">("contact-editor-org");
const A = toSafeId<"contact">("00000000-0000-4000-8000-000000000001");
const B = toSafeId<"contact">("00000000-0000-4000-8000-000000000002");

const contact = (id: typeof A, notes: string | null) =>
  ({
    id,
    organizationId: ORGANIZATION,
    type: "person",
    displayName: id === A ? "Contact A" : "Contact B",
    prefix: null,
    firstName: null,
    middleName: null,
    lastName: null,
    suffix: null,
    organizationName: null,
    notes,
    emails: [],
    phones: [],
    addresses: null,
    tags: null,
    metadata: { version: 1, dataBoxes: [], customFields: [] },
    color: null,
    registrationNumber: null,
    taxId: null,
    bankAccounts: null,
    billingAddress: null,
    defaultHourlyRate: null,
    currency: null,
    paymentTermDays: null,
    originatingAttorneyId: null,
    responsibleAttorneyId: null,
    originatingAttorney: null,
    responsibleAttorney: null,
    dateOfBirth: null,
    nationalityCodes: [],
    sanctionsMonitoringMode: "included",
    createdBy: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    clientMatterCount: 0,
    clientMatters: [],
    partyCount: 0,
    partyMatters: [],
  }) satisfies ContactData;

afterEach(() => {
  testing.cleanup();
  mock.restore();
  posts.length = 0;
  serverContacts.clear();
  heldContactReads.clear();
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const mountPage = async (children: () => ReactNode, client: Client) => {
  const remountDeps = contactRoute.options.remountDeps;
  if (!remountDeps) {
    throw new Error("Contact route must declare remountDeps");
  }
  client.setQueryData(rootKeys.role, "member");
  client.setQueryData(organizationKeys.byOrganization(ORGANIZATION), null);
  let organizationId = ORGANIZATION;
  const root = router.createRootRoute({ component: router.Outlet });
  const protectedRoute = router.createRoute({
    getParentRoute: () => root,
    id: "_protected",
    beforeLoad: () => ({ user: { activeOrganizationId: organizationId } }),
  });
  const page = router.createRoute({
    getParentRoute: () => protectedRoute,
    path: "/contacts/$contactId",
    // Exercise the production route's identity policy with the real editors.
    remountDeps,
    component: children,
  });
  const appRouter = router.createRouter({
    routeTree: root.addChildren([protectedRoute.addChildren([page])]),
    history: router.createMemoryHistory({ initialEntries: [`/contacts/${A}`] }),
    isServer: false,
  });
  await appRouter.load();
  const view = testing.render(
    <query.QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <router.RouterProvider router={appRouter} />
        </FormattingProvider>
      </IntlProvider>
    </query.QueryClientProvider>,
  );
  return {
    view,
    appRouter,
    switchOrganization: async () => {
      organizationId = toSafeId<"organization">("other-org");
      await testing.act(async () => await appRouter.invalidate());
    },
  };
};

const createClient = () =>
  new query.QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });

const nextPost = async (index = 0) => {
  await testing.waitFor(() => expect(posts.length).toBeGreaterThan(index));
  const post = posts.at(index);
  if (!post) {
    throw new Error("Expected pending contact update");
  }
  return post;
};

const notesPage = () => {
  const contactId = router.useParams({
    from: "/_protected/contacts/$contactId",
    select: (params) => params.contactId,
  });
  const { data } = query.useSuspenseQuery(
    contactOptions(ORGANIZATION, contactId),
  );
  return <ContactNotesEditor contact={data} />;
};

const ratePage = () => {
  const { data } = query.useSuspenseQuery(contactOptions(ORGANIZATION, A));
  return (
    <EditableRow
      key={`default-hourly-rate-${data.currency ?? "none"}`}
      contact={data}
      field="defaultHourlyRate"
      label="Hourly rate"
    />
  );
};

for (const currency of ["EUR", "JPY", "KWD", null]) {
  test(`changing currency to ${currency ?? "none"} discards an active hourly-rate draft`, async () => {
    const client = createClient();
    const original = {
      ...contact(A, null),
      currency: "GBP",
      defaultHourlyRate: cents(100),
    };
    client.setQueryData(contactOptions(ORGANIZATION, A).queryKey, original);
    const { view } = await mountPage(ratePage, client);
    testing.fireEvent.click(view.getByRole("button"));
    testing.fireEvent.change(view.getByRole("textbox"), {
      target: { value: "150.50" },
    });
    await testing.act(async () => {
      client.setQueryData(contactOptions(ORGANIZATION, A).queryKey, {
        ...original,
        currency,
      });
    });
    await testing.waitFor(() => {
      expect(view.queryByRole("textbox") === null).toBe(true);
    });
    view.unmount();
    expect(posts).toEqual([]);
    client.clear();
  });
}

test("ordinary page unmount commits an active hourly-rate draft", async () => {
  const client = createClient();
  client.setQueryData(contactOptions(ORGANIZATION, A).queryKey, {
    ...contact(A, null),
    currency: "GBP",
    defaultHourlyRate: cents(100),
  });
  const { view } = await mountPage(ratePage, client);
  testing.fireEvent.click(view.getByRole("button"));
  testing.fireEvent.change(view.getByRole("textbox"), {
    target: { value: "150.50" },
  });
  view.unmount();
  const post = await nextPost();
  expect(post.body).toEqual({ defaultHourlyRate: 15_050 });
  await testing.act(async () =>
    post.response.resolve(Response.json({ success: true })),
  );
  client.clear();
});

test("a same-contact refetch preserves an active notes draft", async () => {
  const client = createClient();
  client.setQueryData(
    contactOptions(ORGANIZATION, A).queryKey,
    contact(A, "original"),
  );
  const { view } = await mountPage(notesPage, client);
  testing.fireEvent.change(view.getByRole("textbox"), {
    target: { value: "active draft" },
  });
  await testing.act(async () => {
    await client.query({
      ...contactOptions(ORGANIZATION, A),
      staleTime: 0,
      queryFn: async () => contact(A, "refetched"),
    });
  });
  expect(view.getByRole("textbox")).toHaveProperty("value", "active draft");
  testing.fireEvent.blur(view.getByRole("textbox"));
  const post = await nextPost();
  expect(post.body).toEqual({ notes: "active draft" });
  view.unmount();
  await testing.act(async () =>
    post.response.resolve(Response.json({ success: true })),
  );
  client.clear();
});

test("contact drafts belong to the current route identity", async () => {
  const notes = fc.option(fc.stringMatching(/^[a-zA-Z0-9 ]{0,24}$/u));
  await assertProperty(
    "contact drafts belong to the current route identity",
    fc.asyncProperty(
      notes,
      notes,
      fc.boolean(),
      async (aNotes, nextNotes, equalNotes) => {
        const bNotes = equalNotes ? aNotes : nextNotes;
        const client = createClient();
        client.setQueryData(
          contactOptions(ORGANIZATION, A).queryKey,
          contact(A, aNotes),
        );
        client.setQueryData(
          contactOptions(ORGANIZATION, B).queryKey,
          contact(B, bNotes),
        );
        const { view, appRouter } = await mountPage(notesPage, client);
        try {
          testing.fireEvent.change(view.getByRole("textbox"), {
            target: { value: `${aNotes ?? ""} changed` },
          });
          view.getByRole("textbox").focus();
          await testing.act(async () => {
            await appRouter.navigate({
              to: "/contacts/$contactId",
              params: { contactId: B },
            });
          });
          expect(view.getByRole("textbox")).toHaveProperty(
            "value",
            bNotes ?? "",
          );
          testing.fireEvent.blur(view.getByRole("textbox"));
          const flushed = await nextPost();
          expect(flushed.url).toEndWith(`/contacts/${A}`);
          expect(flushed.body).toEqual({ notes: `${aNotes ?? ""} changed` });
          expect(posts).toHaveLength(1);
        } finally {
          view.unmount();
          for (const post of posts) {
            post.response.resolve(Response.json({ id: A }));
          }
          await testing.waitFor(() => expect(client.isMutating()).toBe(0));
          client.clear();
          posts.length = 0;
        }
      },
    ),
    { numRuns: 12 },
  );
});

test.each(["communication-first", "custom-fields-first"])(
  "section saves submit only owned metadata: %s",
  async (order) => {
    const client = createClient();
    const cached = contact(A, null);
    client.setQueryData(contactsKeys.byId(ORGANIZATION, A), cached);
    client.setQueryData(contactsKeys.lists(ORGANIZATION), []);
    const { view } = await mountPage(
      () => (
        <>
          <ContactCommunicationEditor contact={cached} />
          <ContactCustomFieldsEditor contact={cached} />
        </>
      ),
      client,
    );
    testing.fireEvent.change(
      view.getByPlaceholderText(
        messages.contacts.communication.dataBoxPlaceholder,
      ),
      {
        target: { value: "abc1234" },
      },
    );
    testing.fireEvent.click(
      view.getByRole("button", {
        name: messages.contacts.communication.addDataBox,
      }),
    );
    const communication = await nextPost();
    testing.fireEvent.change(
      view.getByPlaceholderText(
        messages.contacts.customFields.labelPlaceholder,
      ),
      {
        target: { value: "Reference" },
      },
    );
    testing.fireEvent.change(view.getByPlaceholderText(messages.common.value), {
      target: { value: "42" },
    });
    testing.fireEvent.click(
      view.getByRole("button", {
        name: messages.contacts.customFields.addField,
      }),
    );
    const custom = await nextPost(1);
    expect(communication.body).toEqual({
      metadata: { dataBoxes: [{ id: "abc1234", isPrimary: true }] },
    });
    expect(custom.body).toEqual({
      metadata: {
        customFields: [
          { id: expect.any(String), label: "Reference", value: "42" },
        ],
      },
    });
    for (const post of order === "communication-first"
      ? [communication, custom]
      : [custom, communication]) {
      await testing.act(async () =>
        post.response.resolve(Response.json({ id: A })),
      );
      expect(
        client.getQueryState(contactsKeys.byId(ORGANIZATION, A))?.isInvalidated,
      ).toBe(true);
      expect(
        client.getQueryState(contactsKeys.lists(ORGANIZATION))?.isInvalidated,
      ).toBe(true);
    }
    client.clear();
  },
);

test("section removals and field edits keep sibling metadata out of requests", async () => {
  const client = createClient();
  const cached = {
    ...contact(A, null),
    metadata: {
      version: 1,
      dataBoxes: [{ id: "abc1234", isPrimary: true }],
      customFields: [{ id: "reference", label: "Reference", value: "old" }],
    },
  } satisfies ContactData;
  const { view } = await mountPage(
    () => (
      <>
        <ContactCommunicationEditor contact={cached} />
        <ContactCustomFieldsEditor contact={cached} />
      </>
    ),
    client,
  );
  testing.fireEvent.click(
    view.getByRole("button", { name: messages.common.delete }),
  );
  const communication = await nextPost();
  expect(communication.body).toEqual({ metadata: { dataBoxes: [] } });
  await testing.act(async () =>
    communication.response.resolve(Response.json({ success: true })),
  );
  await testing.waitFor(() =>
    expect(
      view
        .getByRole("button", { name: messages.common.delete })
        .hasAttribute("disabled"),
    ).toBe(false),
  );

  const fieldValue = view.getByRole("textbox", {
    name: messages.contacts.customFields.value,
  });
  testing.fireEvent.change(fieldValue, { target: { value: "new" } });
  testing.fireEvent.blur(fieldValue);
  const update = await nextPost(1);
  expect(update.body).toEqual({
    metadata: {
      customFields: [{ id: "reference", label: "Reference", value: "new" }],
    },
  });
  await testing.act(async () =>
    update.response.resolve(Response.json({ success: true })),
  );
  const removeButton = view.getByRole("button", {
    name: messages.contacts.customFields.removeField,
  });
  await testing.waitFor(() =>
    expect(removeButton.hasAttribute("disabled")).toBe(false),
  );
  testing.fireEvent.click(removeButton);
  const removal = await nextPost(2);
  expect(removal.body).toEqual({ metadata: { customFields: [] } });
  view.unmount();
  await testing.act(async () =>
    removal.response.resolve(Response.json({ success: true })),
  );
  client.clear();
});

test.each([200, 500])(
  "update settlement after unmount refreshes only successful writes: %i",
  async (status) => {
    const toast = spyOn(stellaToast, "add").mockImplementation(
      () => "test-toast",
    );
    const client = createClient();
    const keys = [
      contactsKeys.byId(ORGANIZATION, A),
      contactsKeys.list(ORGANIZATION, {}),
      contactPickerKeys.search({ organizationId: ORGANIZATION, q: "A" }),
    ];
    const untouched = [
      contactsKeys.byId(ORGANIZATION, B),
      contactsKeys.list("other-org", {}),
    ];
    for (const key of [...keys, ...untouched]) {
      client.setQueryData(key, { warmed: true });
    }
    const captures: unknown[] = [];
    let successes = 0;
    const SaveButton = () => {
      const update = useUpdateContact();
      return (
        <button
          type="button"
          onClick={() =>
            update.mutate(
              { organizationId: ORGANIZATION, contactId: A, notes: "saved" },
              {
                onSuccess: () => {
                  successes++;
                },
              },
            )
          }
        >
          {messages.common.save}
        </button>
      );
    };
    const Save = () => (
      <AnalyticsContext
        value={{
          ...noopAnalytics,
          captureError: (error) => {
            captures.push(error);
          },
        }}
      >
        <SaveButton />
      </AnalyticsContext>
    );
    const { view, switchOrganization } = await mountPage(Save, client);
    testing.fireEvent.click(view.getByRole("button", { name: "Save" }));
    const post = await nextPost();
    const mutation = client.getMutationCache().getAll().at(0);
    await switchOrganization();
    view.unmount();
    await testing.act(async () =>
      post.response.resolve(
        Response.json(
          status === 200
            ? { success: true }
            : { message: "contact update unavailable" },
          { status },
        ),
      ),
    );
    await testing.waitFor(() =>
      expect(mutation?.state.status).toBe(status === 200 ? "success" : "error"),
    );
    for (const key of keys) {
      expect(client.getQueryState(key)?.isInvalidated).toBe(status === 200);
    }
    for (const key of untouched) {
      expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    }
    expect(successes).toBe(0);
    expect(captures).toHaveLength(status === 200 ? 0 : 1);
    expect(posts).toHaveLength(1);
    expect(toast).toHaveBeenCalledTimes(status === 200 ? 0 : 1);
    client.clear();
  },
);

const workspaceProjectionCases = [
  { patch: { displayName: "Updated contact" }, refreshWorkspaces: true },
  { patch: { responsibleAttorneyId: null }, refreshWorkspaces: true },
  { patch: { originatingAttorneyId: null }, refreshWorkspaces: false },
  { patch: { notes: "updated" }, refreshWorkspaces: false },
] as const satisfies readonly {
  patch: ContactUpdate;
  refreshWorkspaces: boolean;
}[];

test.each(workspaceProjectionCases)(
  "workspace projections refresh for the submitted fields: %j",
  async ({ patch, refreshWorkspaces }) => {
    const client = createClient();
    const key = [...workspacesKeys.all, "warmed-matter"];
    client.setQueryData(key, { warmed: true });
    const Save = () => {
      const update = useUpdateContact();
      return (
        <button
          type="button"
          onClick={() =>
            update.mutate({
              organizationId: ORGANIZATION,
              contactId: A,
              ...patch,
            })
          }
        >
          {messages.common.save}
        </button>
      );
    };
    const { view } = await mountPage(Save, client);
    testing.fireEvent.click(view.getByRole("button", { name: "Save" }));
    const post = await nextPost();
    expect(post.body).toEqual(patch);
    view.unmount();
    const mutation = client.getMutationCache().getAll().at(0);
    await testing.act(async () =>
      post.response.resolve(Response.json({ success: true })),
    );
    await testing.waitFor(() => expect(mutation?.state.status).toBe("success"));
    expect(client.getQueryState(key)?.isInvalidated).toBe(refreshWorkspaces);
    client.clear();
  },
);

const RealPage = () => {
  const Component = contactRoute.options.component;
  if (!Component) {
    throw new Error("Contact route must declare a component");
  }
  return <Component />;
};
const warmPage = (client: Client) => {
  for (const id of [A, B]) {
    const data = {
      ...contact(id, `${id === A ? "A" : "B"} notes`),
      firstName: id === A ? "Alice" : "Bob",
    };
    serverContacts.set(id, data);
    client.setQueryData(contactOptions(ORGANIZATION, id).queryKey, data);
  }
};
const dirtyPage = (view: ReturnType<typeof testing.render>) => {
  testing.fireEvent.click(view.getByRole("button", { name: "Alice" }));
  testing.fireEvent.change(view.getByDisplayValue("Alice"), {
    target: { value: "Edited Alice" },
  });
  testing.fireEvent.change(
    view.getByRole("textbox", { name: messages.common.notes }),
    { target: { value: "Edited notes" } },
  );
  const year = view.getByPlaceholderText(messages.contacts.fields.year);
  testing.fireEvent.change(year, { target: { value: "1990" } });
  expect(document.activeElement).toBe(view.getByDisplayValue("Edited Alice"));
};
const settlePosts = async (client: Client) => {
  await testing.act(async () => {
    for (const post of posts) {
      post.response.resolve(Response.json({ id: A }));
    }
  });
  await testing.waitFor(() => expect(client.isMutating()).toBe(0));
};
test.each(["link", "history"])(
  "real contact page flushes its drafts on %s navigation",
  async (navigation) => {
    const client = createClient();
    warmPage(client);
    const { view, appRouter } = await mountPage(
      () => (
        <>
          <RealPage />
          <router.Link to="/contacts/$contactId" params={{ contactId: B }}>
            {messages.common.next}
          </router.Link>
        </>
      ),
      client,
    );
    if (navigation === "history") {
      await testing.act(async () => appRouter.history.push(`/contacts/${B}`));
      await testing.waitFor(() =>
        expect(view.getByRole("heading", { name: "Contact B" })).toBeDefined(),
      );
      await testing.act(async () => appRouter.history.back());
      await testing.waitFor(() =>
        expect(view.getByRole("heading", { name: "Contact A" })).toBeDefined(),
      );
    }
    dirtyPage(view);
    if (navigation === "link") {
      await testing.act(async () =>
        testing.fireEvent.click(
          view.getByRole("link", { name: messages.common.next }),
        ),
      );
    } else {
      await testing.act(async () => appRouter.history.forward());
    }
    await testing.waitFor(() =>
      expect(view.getByRole("heading", { name: "Contact B" })).toBeDefined(),
    );
    expect(view.getByRole("button", { name: "Bob" })).toBeDefined();
    expect(
      view.getByRole("textbox", { name: messages.common.notes }),
    ).toHaveProperty("value", "B notes");
    expect(
      view.getByPlaceholderText(messages.contacts.fields.year),
    ).toHaveProperty("value", "");
    await testing.waitFor(() => expect(posts).toHaveLength(3));
    expect(posts.map(({ url }) => url.split("/").at(-1))).toEqual([A, A, A]);
    expect(posts.map(({ body }) => body)).toEqual(
      expect.arrayContaining([
        { firstName: "Edited Alice" },
        { notes: "Edited notes" },
        {
          dateOfBirth: { precision: "year", year: 1990 },
          nationalityCodes: [],
        },
      ]),
    );
    testing.fireEvent.blur(
      view.getByRole("textbox", { name: messages.common.notes }),
    );
    expect(posts).toHaveLength(3);
    await settlePosts(client);
    if (navigation === "history") {
      await testing.act(async () => appRouter.history.back());
      await testing.waitFor(() =>
        expect(view.getByRole("heading", { name: "Contact A" })).toBeDefined(),
      );
      await testing.act(async () => appRouter.history.forward());
      await testing.waitFor(() =>
        expect(view.getByRole("heading", { name: "Contact B" })).toBeDefined(),
      );
      expect(
        view.getByRole("textbox", { name: messages.common.notes }),
      ).toHaveProperty("value", "B notes");
    }
    view.unmount();
    client.clear();
  },
);
test("same-contact router invalidation preserves every active draft", async () => {
  const client = createClient();
  warmPage(client);
  const { view, appRouter } = await mountPage(RealPage, client);
  dirtyPage(view);
  const row = view.getByDisplayValue("Edited Alice");
  await testing.act(async () => await appRouter.invalidate());
  expect(view.getByDisplayValue("Edited Alice")).toBe(row);
  expect(
    view.getByRole("textbox", { name: messages.common.notes }),
  ).toHaveProperty("value", "Edited notes");
  expect(
    view.getByPlaceholderText(messages.contacts.fields.year),
  ).toHaveProperty("value", "1990");
  expect(posts).toHaveLength(0);
  await testing.act(async () =>
    appRouter.history.push(`/contacts/${A}?q=changed`),
  );
  await testing.waitFor(() =>
    expect(appRouter.state.location.searchStr).toBe("?q=changed"),
  );
  expect(view.getByDisplayValue("Edited Alice")).toBe(row);
  view.unmount();
  await testing.waitFor(() => expect(posts).toHaveLength(3));
  await settlePosts(client);
  client.clear();
});
test("two quick data-box additions build on refreshed detail while lists refetch", async () => {
  const client = createClient();
  warmPage(client);
  const listResponse = Promise.withResolvers<string[]>();
  const fetchList = async () => await listResponse.promise;
  const observer = new query.QueryObserver(client, {
    queryKey: contactsKeys.lists(ORGANIZATION),
    queryFn: fetchList,
    initialData: [],
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  const { view } = await mountPage(RealPage, client);
  const add = (id: string) => {
    testing.fireEvent.change(
      view.getByPlaceholderText(
        messages.contacts.communication.dataBoxPlaceholder,
      ),
      { target: { value: id } },
    );
    testing.fireEvent.click(
      view.getByRole("button", {
        name: messages.contacts.communication.addDataBox,
      }),
    );
  };
  add("abc1234");
  const first = await nextPost();
  const detailRead = {
    requested: Promise.withResolvers<undefined>(),
    response: Promise.withResolvers<Response>(),
  };
  heldContactReads.set(A, detailRead);
  const refreshed = {
    ...contact(A, "A notes"),
    metadata: {
      version: 1,
      dataBoxes: [{ id: "abc1234", isPrimary: true }],
      customFields: [],
    },
  } satisfies ContactData;
  serverContacts.set(A, refreshed);
  await testing.act(async () => {
    first.response.resolve(Response.json({ id: A }));
    await detailRead.requested.promise;
  });
  expect(client.isMutating()).toBe(1);
  expect(
    view
      .getByPlaceholderText(messages.contacts.communication.dataBoxPlaceholder)
      .hasAttribute("disabled"),
  ).toBe(true);
  heldContactReads.delete(A);
  await testing.act(async () =>
    detailRead.response.resolve(Response.json(refreshed)),
  );
  await testing.waitFor(() =>
    expect(
      view
        .getByPlaceholderText(
          messages.contacts.communication.dataBoxPlaceholder,
        )
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(observer.getCurrentResult().isFetching).toBe(true);
  add("def5678");
  const second = await nextPost(1);
  expect(second.body).toEqual({
    metadata: {
      dataBoxes: [
        { id: "abc1234", isPrimary: true },
        { id: "def5678", isPrimary: false },
      ],
    },
  });
  view.unmount();
  await testing.act(async () => {
    second.response.resolve(Response.json({ id: A }));
    listResponse.resolve([]);
  });
  await testing.waitFor(() => expect(client.isMutating()).toBe(0));
  unsubscribe();
  client.clear();
});

test("invoice draft identity ignores search changes", async () => {
  const remountDeps = invoiceRoute.options.remountDeps;
  if (!remountDeps) {
    throw new Error("Invoice route must declare remountDeps");
  }
  const root = router.createRootRoute({ component: router.Outlet });
  const protectedRoute = router.createRoute({
    getParentRoute: () => root,
    id: "_protected",
  });
  const page = router.createRoute({
    getParentRoute: () => protectedRoute,
    path: "/workspaces/$workspaceId/invoices/$invoiceId",
    component: () => (
      <Input aria-label="Invoice draft" defaultValue="original" />
    ),
  });
  Object.assign(page.options, { remountDeps });
  const appRouter = router.createRouter({
    routeTree: root.addChildren([protectedRoute.addChildren([page])]),
    history: router.createMemoryHistory({
      initialEntries: ["/workspaces/matter-a/invoices/invoice-a"],
    }),
    isServer: false,
  });
  await appRouter.load();
  const view = testing.render(<router.RouterProvider router={appRouter} />);
  const input = view.getByRole("textbox", { name: "Invoice draft" });
  testing.fireEvent.change(input, { target: { value: "active draft" } });
  await testing.act(async () =>
    appRouter.history.push("/workspaces/matter-a/invoices/invoice-a?q=next"),
  );
  await testing.waitFor(() =>
    expect(appRouter.state.location.searchStr).toBe("?q=next"),
  );
  expect(view.getByRole("textbox", { name: "Invoice draft" })).toBe(input);
  expect(input).toHaveProperty("value", "active draft");
  await testing.act(async () =>
    appRouter.history.push("/workspaces/matter-a/invoices/invoice-b?q=next"),
  );
  await testing.waitFor(() =>
    expect(view.getByRole("textbox", { name: "Invoice draft" })).not.toBe(
      input,
    ),
  );
  expect(view.getByRole("textbox", { name: "Invoice draft" })).toHaveProperty(
    "value",
    "original",
  );
});

test("cancelled notes and inline drafts do not flush when leaving", async () => {
  const client = createClient();
  warmPage(client);
  const { view } = await mountPage(RealPage, client);
  testing.fireEvent.click(view.getByRole("button", { name: "Alice" }));
  const row = view.getByDisplayValue("Alice");
  testing.fireEvent.change(row, { target: { value: "cancelled name" } });
  testing.fireEvent.keyDown(row, { key: "Escape" });
  const notes = view.getByRole("textbox", { name: messages.common.notes });
  notes.focus();
  testing.fireEvent.change(notes, { target: { value: "cancelled notes" } });
  testing.fireEvent.keyDown(notes, { key: "Escape" });
  view.unmount();
  await testing.act(async () => undefined);
  expect(posts).toHaveLength(0);
  client.clear();
});
test("blurred notes and committed rows flush only once when leaving", async () => {
  const client = createClient();
  warmPage(client);
  const { view } = await mountPage(RealPage, client);
  testing.fireEvent.click(view.getByRole("button", { name: "Alice" }));
  const row = view.getByDisplayValue("Alice");
  testing.fireEvent.change(row, { target: { value: "saved name" } });
  testing.fireEvent.blur(row);
  const notes = view.getByRole("textbox", { name: messages.common.notes });
  testing.fireEvent.change(notes, { target: { value: "saved notes" } });
  testing.fireEvent.blur(notes);
  await testing.waitFor(() => expect(posts).toHaveLength(2));
  view.unmount();
  await settlePosts(client);
  expect(posts).toHaveLength(2);
  client.clear();
});
