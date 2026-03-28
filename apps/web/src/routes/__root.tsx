import { lazy, Suspense } from "react";

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
import { sessionOptions } from "@/routes/-queries";

const isDev = import.meta.env.DEV;
const DevRoot = isDev ? lazy(() async  => import("@/components/dev-root")) : null;

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootComponent,
  // Document head management via route `head` option.
  // https://tanstack.com/router/latest/docs/framework/react/guide/document-head-management
  head: () => ({
    meta: [{ title: "stella" }],
  }),
  beforeLoad: async ({ context }) => {
    const sessionData = await context.queryClient
      .ensureQueryData(sessionOptions)
      .catch(() => null);

    return {
      session: sessionData?.session ?? null,
      user: sessionData?.user ?? null,
    };
  },
  pendingComponent: () => <DefaultPendingComponent className="h-screen" />,
  errorComponent: (props) => (
    <DefaultErrorComponent className="h-screen" {...props} />
  ),
});

function RootComponent() {
  useQuery(sessionOptions);

  return (
    <>
      <HeadContent />
      <div className="flex h-screen w-full flex-col">
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
