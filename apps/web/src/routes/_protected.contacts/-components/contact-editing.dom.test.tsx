import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { QueryClient as Client } from "@tanstack/react-query";
import { afterAll, afterEach, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import type { ContactUpdate } from "@/lib/contacts/mutations";
import type { ContactData } from "@/routes/_protected.contacts/-components/types";

GlobalRegistrator.register({ url: "http://localhost:3000/contacts/a" });

const originalFetch = globalThis.fetch;
type PendingPost = {
  url: string;
  body: Record<string, unknown>;
  response: ReturnType<typeof Promise.withResolvers<Response>>;
};
const posts: PendingPost[] = [];
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
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
const { ContactNotesEditor } =
  await import("@/routes/_protected.contacts/-components/contact-notes-editor");
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
    metadata: { dataBoxes: [], customFields: [] },
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
  posts.length = 0;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

const mountPage = async (children: () => ReactNode, client: Client) => {
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
    remountDeps: contactRoute.options.remountDeps,
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
        <router.RouterProvider router={appRouter} />
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

test.each([null, "B's own notes"])(
  "contact navigation initializes notes from the destination: %s",
  async (bNotes) => {
    const client = createClient();
    client.setQueryData(
      contactOptions(ORGANIZATION, A).queryKey,
      contact(A, null),
    );
    client.setQueryData(
      contactOptions(ORGANIZATION, B).queryKey,
      contact(B, bNotes),
    );
    const { view, appRouter } = await mountPage(notesPage, client);
    const source = view.getByRole("textbox", { name: messages.common.notes });
    testing.fireEvent.change(source, { target: { value: "A's active draft" } });
    source.focus();
    expect(document.activeElement).toBe(source);

    await testing.act(async () => {
      await appRouter.navigate({
        to: "/contacts/$contactId",
        params: { contactId: B },
      });
    });
    const destination = view.getByRole("textbox", {
      name: messages.common.notes,
    });
    expect(destination).not.toBe(source);
    expect(destination).toHaveProperty("value", bNotes ?? "");
    testing.fireEvent.blur(destination);
    expect(posts).toHaveLength(0);

    destination.focus();
    testing.fireEvent.change(destination, {
      target: { value: "B's active draft" },
    });
    await testing.act(async () => appRouter.history.back());
    await testing.waitFor(() =>
      expect(view.getByRole("textbox")).toHaveProperty("value", ""),
    );
    view.getByRole("textbox").focus();
    await testing.act(async () => appRouter.history.forward());
    await testing.waitFor(() =>
      expect(view.getByRole("textbox")).toHaveProperty("value", bNotes ?? ""),
    );

    testing.fireEvent.change(view.getByRole("textbox"), {
      target: { value: "B's next note" },
    });
    testing.fireEvent.blur(view.getByRole("textbox"));
    const post = await nextPost();
    expect(post.url).toEndWith(`/contacts/${B}`);
    expect(post.body).toEqual({ notes: "B's next note" });
    view.unmount();
    await testing.act(async () =>
      post.response.resolve(Response.json({ success: true })),
    );
    client.clear();
  },
);

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
    await client.fetchQuery({
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
          expect(posts).toHaveLength(0);
        } finally {
          view.unmount();
          client.clear();
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
    const serverMetadata = { ...cached.metadata };
    for (const post of order === "communication-first"
      ? [communication, custom]
      : [custom, communication]) {
      if (
        typeof post.body.metadata !== "object" ||
        post.body.metadata === null
      ) {
        throw new Error("Expected metadata section");
      }
      Object.assign(serverMetadata, post.body.metadata);
      await testing.act(async () =>
        post.response.resolve(Response.json({ success: true })),
      );
    }
    expect(serverMetadata).toEqual({
      dataBoxes: [{ id: "abc1234", isPrimary: true }],
      customFields: [
        { id: expect.any(String), label: "Reference", value: "42" },
      ],
    });
    client.clear();
  },
);

test("section removals and field edits keep sibling metadata out of requests", async () => {
  const client = createClient();
  const cached = {
    ...contact(A, null),
    metadata: {
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
              { onSuccess: () => successes++ },
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
