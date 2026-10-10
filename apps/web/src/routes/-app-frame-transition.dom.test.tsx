import type { ReactElement } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/frame" });
Object.assign(import.meta.env, { VITE_PUBLIC_KNOWLEDGE_ENABLED: "true" });

const testing = await import("@testing-library/react");
const { QueryClient, QueryClientProvider, hashKey, useQuery, useQueryClient } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { rootKeys, sessionOptions } = await import("@/lib/auth-queries");
const { useMountEffect } = await import("@/hooks/use-effect");
const { memberKnowledgeKeys } = await import("@/lib/knowledge/knowledge-cache");
const { installSessionCacheGuard, settleAuthTransition } =
  await import("@/lib/session-cache-guard");
const { AppFrameHost } = await import("@/routes/-app-frame-host");

const member = (organizationId: string) =>
  ({
    activeOrganizationId: organizationId,
    id: "frame-member",
    email: "frame@example.test",
    image: null,
    name: "Frame member",
    preferredName: null,
    timezoneId: "UTC",
    wordEditShortcut: null,
  }) satisfies AuthenticatedUser;

const session = (organizationId: string) => ({
  session: { userId: "frame-member", activeOrganizationId: organizationId },
  user: member(organizationId),
});
const frameKey = (organizationId: string) =>
  [...memberKnowledgeKeys.all(), organizationId, "frame-observation"] as const;

afterAll(async () => {
  testing.cleanup();
  await testing.act(async () => {
    await sleep(50);
  });
  await unregisterDomEnvironment();
});

test("frame replacement completes cleanup after a delayed route update", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(rootKeys.session, session("frame-one"));
  const uninstallGuard = installSessionCacheGuard(queryClient, {
    isAuthFlowPage: () => false,
    reloadDocument: () => undefined,
    reloadDocumentAt: () => undefined,
  });
  const observations: string[] = [];
  const MemberFrame = ({
    user,
    children,
  }: {
    user: AuthenticatedUser;
    children: ReactElement;
  }) => {
    const client = useQueryClient();
    const { data: current } = useQuery({ ...sessionOptions, enabled: false });
    const { data } = useQuery({
      queryKey: frameKey(user.activeOrganizationId),
      queryFn: async () => {
        await Promise.resolve();
        return client.getQueryState(rootKeys.session)?.data;
      },
    });
    useMountEffect(() => {
      observations.push(`mounted:${user.activeOrganizationId}`);
      return () => {
        observations.push(`unmounted:${user.activeOrganizationId}`);
      };
    });
    return (
      <div data-testid={`frame-${user.activeOrganizationId}`}>
        <span>{current?.session.activeOrganizationId}</span>
        <span>{data === undefined ? "waiting" : "observed"}</span>
        {children}
      </div>
    );
  };
  const PublicFrame = ({ children }: { children: ReactElement }) => children;
  const frames = { member: MemberFrame, public: PublicFrame };
  const contextStarted = Promise.withResolvers<undefined>();
  const contextReleased = Promise.withResolvers<undefined>();
  let routeMember = member("frame-one");
  let delayContext = false;
  const rootRoute = router.createRootRoute({
    component: () => (
      <AppFrameHost frames={frames}>
        <router.Outlet />
      </AppFrameHost>
    ),
  });
  const protectedRoute = router.createRoute({
    getParentRoute: () => rootRoute,
    id: "_protected",
    beforeLoad: async () => {
      if (delayContext) {
        contextStarted.resolve(undefined);
        await contextReleased.promise;
      }
      return { user: routeMember };
    },
  });
  const pageRoute = router.createRoute({
    getParentRoute: () => protectedRoute,
    path: "/frame",
    component: () => <p data-testid="frame-content" />,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/frame"] }),
    isServer: false,
    routeTree: rootRoute.addChildren([protectedRoute.addChildren([pageRoute])]),
  });
  await appRouter.load();
  const view = testing.render(
    <QueryClientProvider client={queryClient}>
      <router.RouterProvider router={appRouter} />
    </QueryClientProvider>,
  );
  const removalsAfterHiding: boolean[] = [];
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type === "removed" &&
      event.query.queryHash === hashKey(frameKey("frame-one"))
    ) {
      removalsAfterHiding.push(view.queryByTestId("frame-frame-one") === null);
    }
  });
  try {
    await testing.waitFor(() => {
      expect(view.getByTestId("frame-frame-one").textContent).toContain(
        "observed",
      );
    });
    await testing.act(async () => {
      queryClient.setQueryData(rootKeys.session, session("frame-two"));
      await settleAuthTransition(queryClient);
    });
    // The mounted observer still uses the matched route's first context.
    await testing.waitFor(() => {
      expect(queryClient.getQueryState(frameKey("frame-one"))?.data).toEqual(
        session("frame-two"),
      );
    });
    expect(view.queryByTestId("frame-frame-one")).not.toBeNull();
    expect(removalsAfterHiding).toContain(false);

    routeMember = member("frame-two");
    delayContext = true;
    const invalidation = { pending: Promise.resolve() };
    testing.act(() => {
      invalidation.pending = appRouter.invalidate();
    });
    await contextStarted.promise;
    expect(view.queryByTestId("frame-frame-one")).not.toBeNull();
    await testing.act(async () => {
      contextReleased.resolve(undefined);
      await invalidation.pending;
    });
    await testing.waitFor(() => view.getByTestId("frame-frame-two"));
    expect(observations).toContain("unmounted:frame-one");
    expect(removalsAfterHiding).toContain(true);
    expect(queryClient.getQueryState(frameKey("frame-one"))).toBeUndefined();
  } finally {
    contextReleased.resolve(undefined);
    unsubscribe();
    uninstallGuard();
    view.unmount();
    queryClient.clear();
  }
});
