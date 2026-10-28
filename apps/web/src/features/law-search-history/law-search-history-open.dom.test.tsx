import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, spyOn, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { MEMBER_SESSION } from "@/lib/account/auth-session.test-fixtures";
import { sessionOptions } from "@/lib/auth-query-options";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} = await import("@tanstack/react-router");
const { act, cleanup, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { useRecordOpenedLawDocument } =
  await import("./law-search-history-query");

afterAll(async () => {
  await unregisterDomEnvironment();
});

const DECISION_PATH = "/law/cz/cases/ns/23-cdo-3362-2022";

const OpenedDecision = () => {
  useRecordOpenedLawDocument({
    kind: "decision",
    documentId: "decision-1",
    documentIdentity: { kind: "unknown" },
    title: { identifier: "23 Cdo 3362/2022", description: "Nejvyšší soud" },
  });
  return null;
};

test("a page left for a loading route records under its own path", async () => {
  const recorded: unknown[] = [];
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const request = input instanceof Request ? input : undefined;
        if ((init?.method ?? request?.method ?? "GET") === "POST") {
          const body = init?.body ?? (await request?.text());
          recorded.push(typeof body === "string" ? JSON.parse(body) : null);
          return Response.json({ id: "entry-1" });
        }
        return Response.json({
          items: [],
          nextCursor: null,
          scope: {
            userId: MEMBER_SESSION.user.id,
            organizationId: MEMBER_SESSION.session.activeOrganizationId,
          },
        });
      },
      { preconnect: () => undefined },
    ),
  );
  const client = new QueryClient();
  client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  const homeLoad = Promise.withResolvers<null>();
  const root = createRootRoute();
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/law",
        loader: async () => await homeLoad.promise,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/law/$country/cases/$court/$slug",
        component: OpenedDecision,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [DECISION_PATH] }),
  });
  try {
    await router.load();
    render(
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <RouterProvider router={router} />
        </IntlProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(recorded).toHaveLength(1));

    // The decision stays mounted while the next route's loader runs, and the
    // router's location already names that next route.
    await act(async () => {
      void router.navigate({ to: "/law" });
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/law");
      expect(router.state.status).toBe("pending");
    });
    await waitFor(() => expect(client.isMutating()).toBe(0));

    expect(recorded).toEqual([
      expect.objectContaining({ kind: "decision", path: DECISION_PATH }),
    ]);
  } finally {
    homeLoad.resolve(null);
    await act(async () => cleanup());
    client.clear();
    transport.mockRestore();
  }
});
