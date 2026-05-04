import { lazy, Suspense, useEffect } from "react";

import { useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
} from "@tanstack/react-router";

import {
  DefaultErrorComponent,
  DefaultPendingComponent,
} from "@/components/route-components";
import { useAnalytics } from "@/lib/analytics/provider";
import { ensureCriticalQueryData } from "@/lib/react-query";
import { sessionOptions } from "@/routes/-queries";

const isDev = import.meta.env.DEV;
const DevRoot = isDev
  ? // eslint-disable-next-line require-await -- lazy() requires async import
    lazy(async () => import("@/components/dev-root"))
  : null;

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootComponent,
  beforeLoad: async ({ context }) => {
    const sessionData = await ensureCriticalQueryData(
      context.queryClient,
      sessionOptions,
    ).catch(() => null);

    return {
      session: sessionData?.session ?? null,
      user: sessionData?.user ?? null,
    };
  },
  // Document head management via route `head` option.
  // https://tanstack.com/router/latest/docs/framework/react/guide/document-head-management
  head: () => ({
    meta: [{ title: "stella" }],
  }),
  pendingComponent: () => <DefaultPendingComponent className="h-dvh" />,
  errorComponent: (props) => (
    <DefaultErrorComponent className="h-dvh" {...props} />
  ),
});

function RootComponent() {
  useQuery(sessionOptions);

  return (
    <>
      <HeadContent />
      <RootAnalyticsIdentity />
      <div className="flex h-dvh w-full flex-col">
        <Outlet />
        {DevRoot ? (
          <Suspense fallback={null}>
            <DevRoot />
          </Suspense>
        ) : null}
      </div>
    </>
  );
}

const RootAnalyticsIdentity = () => {
  const analytics = useAnalytics();
  const user = Route.useRouteContext({ select: (context) => context.user });

  useEffect(() => {
    if (user === null) {
      analytics.reset({ onlyIfIdentified: true });
      return;
    }
    analytics.identifyUser({
      id: user.id,
      email: user.email,
      name: user.name ?? undefined,
    });
  }, [analytics, user]);

  return null;
};
