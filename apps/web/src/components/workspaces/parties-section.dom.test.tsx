import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
const { act } = await import("react");
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { PartiesSection } = await import("./parties-section");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { workspaceContactsOptions } =
  await import("@/lib/workspaces/queries/workspace-contacts");

type ContactRead = NonNullable<
  Awaited<
    ReturnType<
      NonNullable<ReturnType<typeof workspaceContactsOptions>["queryFn"]>
    >
  >
>;
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "organization-parties-test";
const TEST_USER = {
  activeOrganizationId: ORGANIZATION_ID,
  id: "user-parties-test",
  email: "member@example.test",
  image: null,
  name: "Test member",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const originalFetch = globalThis.fetch;
const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
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

const renderParties = async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const root = createRootRoute({
    component: () => <PartiesSection workspaceId={WORKSPACE_ID} />,
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <AuthenticatedUserProvider user={TEST_USER}>
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </AuthenticatedUserProvider>
      </FormattingProvider>
    </IntlProvider>,
  );
  return view;
};

test.each([
  { kind: "client", status: 500, code: "internal_server_error" },
  { kind: "personal", status: 500, code: "internal_server_error" },
  { kind: "client", status: 422, code: "matter_contact_capacity_exceeded" },
  { kind: "personal", status: 422, code: "matter_contact_capacity_exceeded" },
])(
  "a failed $kind contacts read ($code) shows an error and retry",
  async ({ kind, status, code }) => {
    let reads = 0;
    const initialRead = Promise.withResolvers<Response>();
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.pathname === `/v1/workspaces/${WORKSPACE_ID}`) {
          return Response.json({
            id: WORKSPACE_ID,
            name: "Matter",
            client:
              kind === "personal"
                ? null
                : {
                    id: "00000000-0000-4000-a000-000000000001",
                    type: "person",
                    displayName: "Client",
                    color: null,
                  },
          });
        }
        if (url.pathname === `/v1/workspaces/${WORKSPACE_ID}/contacts`) {
          reads += 1;
          if (reads === 1) {
            return await initialRead.promise;
          }
          return Response.json({
            contacts: [],
            overflow: false,
          } satisfies ContactRead);
        }
        throw new Error(`Unexpected parties transport: ${url.pathname}`);
      },
      { preconnect: () => undefined },
    );
    const view = await renderParties();
    await waitFor(() =>
      expect(
        view.getByRole("status", { name: messages.common.loading }),
      ).toBeDefined(),
    );
    expect(view.queryByText(messages.workspaces.parties.noParties)).toBeNull();
    await act(async () => {
      initialRead.resolve(
        Response.json({ code, message: "Internal read details" }, { status }),
      );
    });
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain(
        status === 422
          ? messages.errors.apiCodes.matterContactCapacityExceeded
          : messages.errors.actionFailed,
      ),
    );
    expect(view.queryByText(messages.workspaces.parties.noParties)).toBeNull();
    expect(view.queryByText("Internal read details")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: messages.common.retry }));
    await waitFor(() =>
      expect(
        view.getByText(messages.workspaces.parties.noParties),
      ).toBeDefined(),
    );
    expect(view.queryByRole("alert")).toBeNull();
    expect(reads).toBe(2);
  },
);

test.each(["client", "personal"])(
  "an overflowing %s matter retains visible links and allows removing them",
  async (kind) => {
    const links = Array.from(
      { length: 101 },
      (_, index) =>
        ({
          id: toSafeId<"workspaceContact">(
            `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          ),
          workspaceId: toSafeId<"workspace">(WORKSPACE_ID),
          organizationId: toSafeId<"organization">("org_parties"),
          contactId: toSafeId<"contact">(
            `00000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}`,
          ),
          role: "witness" as const,
          isPrimary: false,
          notes: null,
          createdAt: "2026-10-01T00:00:00.000Z",
          contact: {
            id: toSafeId<"contact">(
              `00000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}`,
            ),
            type: "person" as const,
            displayName: `Witness ${index + 1}`,
            color: null,
          },
        }) satisfies ContactRead["contacts"][number],
    );
    const initialRead = Promise.withResolvers<Response>();
    const deletions: string[] = [];
    let reads = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.pathname === `/v1/workspaces/${WORKSPACE_ID}`) {
          return Response.json({
            id: WORKSPACE_ID,
            name: "Matter",
            client:
              kind === "personal"
                ? null
                : {
                    id: "00000000-0000-4000-a000-000000000001",
                    type: "person",
                    displayName: "Client",
                    color: null,
                  },
          });
        }
        if (url.pathname === `/v1/workspaces/${WORKSPACE_ID}/contacts`) {
          reads += 1;
          if (reads === 1) {
            return await initialRead.promise;
          }
          return Response.json({
            contacts: links.slice(1),
            overflow: false,
          } satisfies ContactRead);
        }
        if (
          (init?.method ??
            (input instanceof Request ? input.method : "GET")) === "DELETE"
        ) {
          deletions.push(url.pathname);
          return Response.json({ success: true });
        }
        throw new Error(`Unexpected parties transport: ${url.pathname}`);
      },
      { preconnect: () => undefined },
    );
    const view = await renderParties();
    await waitFor(() =>
      expect(
        view.getByRole("status", { name: messages.common.loading }),
      ).toBeDefined(),
    );
    expect(view.queryByText(messages.workspaces.parties.noParties)).toBeNull();
    await act(async () => {
      initialRead.resolve(
        Response.json({
          contacts: links.slice(0, 100),
          overflow: true,
        } satisfies ContactRead),
      );
    });
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toContain(
        messages.errors.apiCodes.matterContactCapacityExceeded,
      ),
    );
    expect(
      view.getAllByRole("button", {
        name: messages.workspaces.parties.removeParty,
      }),
    ).toHaveLength(100);
    expect(view.getByText("Witness 1")).toBeDefined();
    expect(view.queryByText("Witness 101")).toBeNull();
    const button = view
      .getAllByRole("button", { name: messages.workspaces.parties.removeParty })
      .at(0);
    expect(button).toBeDefined();
    if (!button) {
      throw new Error("expected a remove contact link button");
    }
    const removedLink = links.at(0);
    if (!removedLink) {
      throw new Error("expected a first contact link fixture");
    }
    fireEvent.click(button);
    await waitFor(() =>
      expect(deletions).toEqual([
        `/v1/workspaces/${WORKSPACE_ID}/contacts/${removedLink.id}`,
      ]),
    );
    await waitFor(() => expect(view.getByText("Witness 101")).toBeDefined());
    expect(view.queryByText("Witness 1")).toBeNull();
    expect(view.queryByRole("status")).toBeNull();
    expect(
      view.getAllByRole("button", {
        name: messages.workspaces.parties.removeParty,
      }),
    ).toHaveLength(100);
  },
);

test("creating a client from a personal matter succeeds without replay headers", async () => {
  const contactId = "00000000-0000-4000-9000-000000000010";
  const createRequests: {
    body: Record<string, unknown>;
    replayKey: string | null;
  }[] = [];
  const workspaceUpdates: { body: unknown; replayKey: string | null }[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        url.pathname === `/v1/workspaces/${WORKSPACE_ID}` &&
        request.method === "GET"
      ) {
        return Response.json({
          id: WORKSPACE_ID,
          name: "Matter",
          client: null,
        });
      }
      if (url.pathname === `/v1/workspaces/${WORKSPACE_ID}/contacts`) {
        return Response.json({
          contacts: [],
          overflow: false,
        } satisfies ContactRead);
      }
      if (url.pathname === "/v1/workspaces") {
        return Response.json({ workspaces: [] });
      }
      if (url.pathname === "/v1/contacts/search") {
        return Response.json({ items: [] });
      }
      if (url.pathname === "/v1/contacts" && request.method === "PUT") {
        const body = await request.json();
        createRequests.push({
          body,
          replayKey: request.headers.get("Idempotency-Key"),
        });
        return Response.json({
          id: contactId,
          type: "person",
          displayName: "Avery Counsel",
          ...body,
        });
      }
      if (
        url.pathname === `/v1/workspaces/${WORKSPACE_ID}` &&
        request.method === "POST"
      ) {
        workspaceUpdates.push({
          body: await request.json(),
          replayKey: request.headers.get("Idempotency-Key"),
        });
        return Response.json({});
      }
      throw new Error(
        `Unexpected parties transport: ${request.method} ${url.pathname}`,
      );
    },
    { preconnect: () => undefined },
  );

  await renderParties();
  await waitFor(() =>
    expect(
      screen.getByRole("button", {
        name: messages.workspaces.parties.promoteCta,
      }),
    ).toBeDefined(),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.workspaces.parties.promoteCta,
    }),
  );
  fireEvent.input(screen.getByRole("combobox"), {
    target: { value: "Avery Counsel" },
    inputType: "insertText",
  });
  const createChoice = await screen.findByText(
    messages.contacts.createPerson.replace("{name}", "Avery Counsel"),
  );
  fireEvent.click(createChoice);

  await waitFor(() => expect(createRequests).toHaveLength(1));
  const createRequest = createRequests.at(0);
  expect(createRequest).toBeDefined();
  if (!createRequest) {
    throw new Error("expected a contact creation request");
  }
  expect(createRequest.replayKey).toBeNull();
  expect(createRequest.body).toMatchObject({
    displayName: "Avery Counsel",
    type: "person",
  });
  expect(typeof createRequest.body["id"]).toBe("string");
  expect(screen.getByText("Avery Counsel")).toBeDefined();

  const promoteButton = screen
    .getAllByRole("button", { name: messages.workspaces.parties.promoteCta })
    .find((button) => !button.hasAttribute("disabled"));
  expect(promoteButton).toBeDefined();
  if (!promoteButton) {
    throw new Error("expected a selected client to enable promotion");
  }
  fireEvent.click(promoteButton);
  await waitFor(() => expect(workspaceUpdates).toHaveLength(1));
  expect(workspaceUpdates).toEqual([
    {
      body: { clientId: createRequest.body["id"] },
      replayKey: null,
    },
  ]);
});
