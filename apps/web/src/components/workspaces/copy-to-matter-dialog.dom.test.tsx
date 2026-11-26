import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
const originalFetch = globalThis.fetch;
let transferResponse = async (): Promise<Response> =>
  Response.json({ message: "No transfer configured" }, { status: 503 });
const urlOf = (input: string | URL | Request) => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
};
globalThis.fetch = Object.assign(
  async (input: string | URL | Request) => {
    const url = new URL(urlOf(input));
    if (url.pathname.endsWith("/copy-to-workspace")) {
      return await transferResponse();
    }
    if (url.pathname.endsWith("/folders")) {
      return Response.json({ items: [], nextCursor: null });
    }
    if (url.pathname.endsWith("/workspaces")) {
      return Response.json({ workspaces: [] });
    }
    return Response.json({ message: "No session" }, { status: 401 });
  },
  { preconnect: () => undefined },
);

const { act } = await import("react");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { stellaToast } = await import("@stll/ui/toast");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { CopyToMatterDialog } = await import("./copy-to-matter-dialog");

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

test("the mounted move dialog localizes deferred refusals for complete and partial transfers", async () => {
  for (const partial of [false, true]) {
    for (const [code, description] of [
      [
        "entity_transfer_source_changed",
        messages.workspaces.copyToMatter.sourceChanged,
      ],
      [
        "entity_transfer_source_limit",
        messages.workspaces.copyToMatter.sourceVersionLimit,
      ],
      [
        "entity_transfer_source_in_use",
        messages.workspaces.copyToMatter.sourceInUse,
      ],
      [
        "entity_transfer_source_referenced",
        messages.workspaces.copyToMatter.sourceReferenced,
      ],
    ]) {
      const response = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<undefined>();
      let requestCount = 0;
      transferResponse = async () => {
        requestCount += 1;
        if (partial && requestCount === 1) {
          return Response.json({ entityId: "transferred-item" });
        }
        started.resolve(undefined);
        return await response.promise;
      };
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      const closed: boolean[] = [];
      const rootRoute = router.createRootRoute({
        component: () => (
          <CopyToMatterDialog
            entities={(partial
              ? ["first-item", "second-item"]
              : ["first-item"]
            ).map((entityId) => ({
              entityId,
              entityName: entityId,
              kind: "document",
              ancestorIds: [],
            }))}
            initialTargetWorkspaceId="target-matter"
            onOpenChange={(open) => {
              closed.push(open);
            }}
            open
            sourceWorkspaceId="source-matter"
          />
        ),
      });
      const appRouter = router.createRouter({
        history: router.createMemoryHistory({ initialEntries: ["/"] }),
        isServer: false,
        routeTree: rootRoute,
      });
      const add = spyOn(stellaToast, "add").mockReturnValue("move-refusal");
      try {
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
        await waitFor(() =>
          expect(
            view.getByRole("button", {
              name: messages.workspaces.copyToMatter.moveOption,
            }),
          ).toBeDefined(),
        );
        fireEvent.click(
          view.getByRole("button", {
            name: messages.workspaces.copyToMatter.moveOption,
          }),
        );
        fireEvent.click(
          view.getByRole("button", {
            name: messages.workspaces.copyToMatter.moveButton,
          }),
        );
        await started.promise;
        expect(add).not.toHaveBeenCalled();
        await act(async () => {
          response.resolve(
            Response.json(
              {
                code,
                message: "Raw server details",
                retryable:
                  code !== "entity_transfer_source_limit" &&
                  code !== "entity_transfer_source_referenced",
              },
              { status: 409 },
            ),
          );
        });
        await waitFor(() =>
          expect(add).toHaveBeenCalledWith(
            expect.objectContaining({
              description,
              type: partial ? "warning" : "error",
            }),
          ),
        );
        expect(requestCount).toBe(partial ? 2 : 1);
        expect(closed).toEqual(partial ? [false] : []);
        view.unmount();
      } finally {
        add.mockRestore();
        queryClient.clear();
      }
    }
  }
});

test("every opening starts over from the preset target matter", async () => {
  const { useState } = await import("react");
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  type Opening = { open: boolean; preset: string | null };
  const Harness = () => {
    const [opening, setOpening] = useState<Opening>({
      open: true,
      preset: "target-matter",
    });
    return (
      <>
        <button
          onClick={() => setOpening({ open: false, preset: opening.preset })}
          data-testid="close"
          type="button"
        />
        <button
          onClick={() => setOpening({ open: true, preset: "target-matter" })}
          data-testid="open-with-preset"
          type="button"
        />
        <button
          onClick={() => setOpening({ open: true, preset: null })}
          data-testid="open-without-preset"
          type="button"
        />
        <CopyToMatterDialog
          entities={[
            {
              entityId: "first-item",
              entityName: "first-item",
              kind: "document",
              ancestorIds: [],
            },
          ]}
          initialTargetWorkspaceId={opening.preset}
          onOpenChange={(open) => {
            setOpening({ open, preset: opening.preset });
          }}
          open={opening.open}
          sourceWorkspaceId="source-matter"
        />
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
  const submit = (name: string) =>
    view.getByRole("button", { name, hidden: true });
  const isDisabled = (button: HTMLElement) =>
    button.hasAttribute("disabled") ||
    button.getAttribute("aria-disabled") === "true";
  const click = (name: string) => {
    fireEvent.click(view.getByRole("button", { name, hidden: true }));
  };

  // The preset is a target, so the transfer can go; Move changes the button.
  await waitFor(() => {
    expect(isDisabled(submit(messages.common.copy))).toBe(false);
  });
  click(messages.workspaces.copyToMatter.moveOption);
  expect(submit(messages.workspaces.copyToMatter.moveButton)).toBeDefined();

  // Closed by its owner, and opened again: back to copying into the preset.
  fireEvent.click(view.getByTestId("close"));
  await waitFor(() => {
    expect(
      view.queryByText(messages.workspaces.copyToMatter.title) === null,
    ).toBe(true);
  });
  fireEvent.click(view.getByTestId("open-with-preset"));
  await waitFor(() => {
    expect(isDisabled(submit(messages.common.copy))).toBe(false);
  });

  // A drop without a preset, while open, starts with no target at all.
  fireEvent.click(view.getByTestId("open-without-preset"));
  await waitFor(() => {
    expect(isDisabled(submit(messages.common.copy))).toBe(true);
  });
  view.unmount();
  queryClient.clear();
});
