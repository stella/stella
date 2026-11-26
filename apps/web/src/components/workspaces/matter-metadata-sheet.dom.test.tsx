import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
const originalFetch = globalThis.fetch;
// Only the seeded matters are read; every other request is refused.
globalThis.fetch = Object.assign(
  async () => Response.json({ message: "No session" }, { status: 401 }),
  { preconnect: () => undefined },
);

const { useState } = await import("react");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { workspacesKeys } = await import("@/lib/workspaces/queries");
const { MatterMetadataPanel } = await import("./matter-metadata-sheet");

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

// What the panel and the sections beside it read from the matter.
const matter = (name: string, reference: string) => ({
  client: null,
  leadUserId: null,
  name,
  reference,
  stampedVersionCount: 0,
  visibility: "all_members",
});

test("the name follows the saved matter until edited, survives a failed refetch, and starts over on another matter", async () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(
    workspacesKeys.byId("matter-one"),
    matter("Lease", "L-1"),
  );
  queryClient.setQueryData(
    workspacesKeys.byId("matter-two"),
    matter("Merger", "M-2"),
  );
  const Harness = () => {
    const [workspaceId, setWorkspaceId] = useState("matter-one");
    return (
      <>
        <button
          data-testid="show-matter-two"
          onClick={() => setWorkspaceId("matter-two")}
          type="button"
        />
        <MatterMetadataPanel workspaceId={workspaceId} />
      </>
    );
  };
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/"] }),
    isServer: false,
    routeTree: router.createRootRoute({ component: Harness }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AuthenticatedUserProvider
        user={{
          activeOrganizationId: "test-org",
          email: "member@example.test",
          id: "member",
          image: null,
          name: "Member",
          preferredName: null,
          timezoneId: "UTC",
          wordEditShortcut: null,
        }}
      >
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <TooltipProvider>
            <router.RouterProvider router={appRouter} />
          </TooltipProvider>
        </IntlProvider>
      </AuthenticatedUserProvider>
    </QueryClientProvider>,
  );
  const nameInput = () => {
    const input = view.container.querySelector("input");
    if (input === null) {
      throw new TypeError("no name field");
    }
    return input;
  };
  // Hidden, the field is either gone or under a host that is not displayed.
  const nameShown = () => {
    const input = view.container.querySelector("input");
    let node: HTMLElement | null = input;
    while (node !== null) {
      if (node.style.display === "none") {
        return false;
      }
      node = node.parentElement;
    }
    return input !== null;
  };
  const nameValue = () =>
    view.container.querySelector("input")?.value ?? "(no field)";

  await waitFor(() => {
    expect(nameValue()).toBe("Lease");
  });

  // Untouched, a refetched name comes through.
  await act(async () => {
    queryClient.setQueryData(
      workspacesKeys.byId("matter-one"),
      matter("Lease renewal", "L-1"),
    );
  });
  await waitFor(() => {
    expect(nameValue()).toBe("Lease renewal");
  });

  // Edited, the draft stays over a refetch.
  fireEvent.change(nameInput(), { target: { value: "Draft name" } });
  await act(async () => {
    queryClient.setQueryData(
      workspacesKeys.byId("matter-one"),
      matter("Lease renewal 2", "L-1"),
    );
  });
  await waitFor(() => {
    expect(nameValue()).toBe("Draft name");
  });

  // A background refetch that fails hides the form but keeps the draft.
  await act(async () => {
    queryClient
      .getQueryCache()
      .find({ queryKey: workspacesKeys.byId("matter-one") })
      ?.setState({ error: new Error("offline"), status: "error" });
  });
  await waitFor(() => {
    expect(nameShown()).toBe(false);
  });
  await act(async () => {
    queryClient.setQueryData(
      workspacesKeys.byId("matter-one"),
      matter("Lease renewal 3", "L-1"),
    );
  });
  await waitFor(() => {
    expect(nameValue()).toBe("Draft name");
  });

  // Another matter starts from its own saved name.
  fireEvent.click(view.getByTestId("show-matter-two"));
  await waitFor(() => {
    expect(nameValue()).toBe("Merger");
  });
  view.unmount();
  queryClient.clear();
});
