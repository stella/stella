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
  errorComponent: (props) => (
    <DefaultErrorComponent className="h-dvh" {...props} />
  ),
});

function RootComponent() {
  const appContext = Route.useRouteContext({
    select: (context) => ({
      analyticsValue: context.analyticsValue,
      queryClient: context.queryClient,
    }),
  });

  return (
    <AppProviders
      analyticsValue={appContext.analyticsValue}
      queryClient={appContext.queryClient}
    >
      <RootApp />
    </AppProviders>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <script src="/dark-mode-init.js" />
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
