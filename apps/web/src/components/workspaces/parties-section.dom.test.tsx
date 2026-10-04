import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
const { act } = await import("react");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { PartiesSection } = await import("./parties-section");
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
  await GlobalRegistrator.unregister();
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
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
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
