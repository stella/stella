import { lazy, Suspense } from "react";
import type { ReactNode } from "react";

import type { QueryClient } from "@tanstack/react-query";
import {
  ClientOnly,
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";

import { AppProviders } from "@/app-providers";
import {
  DefaultErrorComponent,
  DefaultPendingComponent,
} from "@/components/route-components";
import type { AnalyticsValue } from "@/lib/analytics/provider";
import type { RouteErrorLifecycleController } from "@/lib/analytics/route-error-lifecycle";
import { RouteErrorLifecycleProvider } from "@/lib/analytics/route-error-lifecycle-context";
import "@/fonts.css";
import { isPublicSsrPath } from "@/lib/public-ssr-paths";
import "@stll/ui/globals.css";

const isDev = import.meta.env.DEV;
const DevRoot = isDev
  ? lazy(async () => await import("@/components/dev-root"))
  : null;

export const Route = createRootRouteWithContext<{
  analyticsValue: AnalyticsValue;
  queryClient: QueryClient;
  routeErrorLifecycle: RouteErrorLifecycleController;
}>()({
  ssr: ({ location }) => isPublicSsrPath(location.pathname),
  shellComponent: RootDocument,
  component: RootComponent,
  // Document head management via route `head` option.
  // https://tanstack.com/router/latest/docs/framework/react/guide/document-head-management
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1.0" },
      { title: "stella" },
    ],
    links: [
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "alternate icon", href: "/favicon.ico" },
    ],
  }),
  pendingComponent: () => <DefaultPendingComponent className="h-dvh" />,
  errorComponent: RootErrorComponent,
});

function RootComponent() {
  const appContext = Route.useRouteContext({
    select: (context) => ({
      analyticsValue: context.analyticsValue,
      queryClient: context.queryClient,
      routeErrorLifecycle: context.routeErrorLifecycle,
    }),
  });

  return (
    <RouteErrorLifecycleProvider controller={appContext.routeErrorLifecycle}>
      <AppProviders
        analyticsValue={appContext.analyticsValue}
        queryClient={appContext.queryClient}
      >
        <RootApp />
      </AppProviders>
    </RouteErrorLifecycleProvider>
  );
}

function RootErrorComponent(
  props: Parameters<typeof DefaultErrorComponent>[0],
) {
  const routeErrorLifecycle = Route.useRouteContext({
    select: (context) => context.routeErrorLifecycle,
  });

  return (
    <RouteErrorLifecycleProvider controller={routeErrorLifecycle}>
      <DefaultErrorComponent className="h-dvh" {...props} />
    </RouteErrorLifecycleProvider>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    // prepaint-init.js mutates the html element's class, and for RTL
    // locales its lang/dir, before React hydrates the document, so the
    // attribute set never matches the server markup; suppress the
    // per-element warning rather than letting every SSR page log a
    // recovered hydration error. lang/dir stay declared here so the
    // server-rendered markup keeps a sane LTR default for clients that
    // never run the script.
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <head>
        <HeadContent />

        <script src="/prepaint-init.js" />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootApp() {
  return (
    <div className="flex h-dvh w-full flex-col" id="app">
      <Outlet />
      {DevRoot ? (
        <ClientOnly>
          <Suspense fallback={null}>
            <DevRoot />
          </Suspense>
        </ClientOnly>
      ) : null}
    </div>
  );
}
