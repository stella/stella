import { lazy, Suspense } from "react";
import type { ReactNode } from "react";

import type { QueryClient } from "@tanstack/react-query";
import {
  ClientOnly,
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
  type ErrorComponentProps,
} from "@tanstack/react-router";

import { AppProviders } from "@/app-providers";
import { ApiVersionMismatchProvider } from "@/components/api-version-mismatch-refresh";
import {
  DefaultErrorComponent,
  DefaultPendingComponent,
} from "@/components/route-components";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { getLangDir, useI18nStore } from "@/i18n/i18n-store";
import type { AnalyticsValue } from "@/lib/analytics/provider";
import "@/fonts.css";
import type { RouteErrorLifecycleController } from "@/lib/analytics/route-error-lifecycle";
import { RouteErrorLifecycleProvider } from "@/lib/analytics/route-error-lifecycle-context";
import {
  applyDocumentLanguage,
  pageDocumentLanguage,
  resolveDocumentLanguage,
} from "@/lib/document-language";
import { isPublicSsrPath } from "@/lib/public-ssr-paths";
import "@/styles/app.css";

const isDev = import.meta.env.DEV;
const DevRoot = isDev
  ? lazy(async () => await import("@/components/dev-root"))
  : null;

export const Route = createRootRouteWithContext<{
  analyticsValue: AnalyticsValue;
  queryClient: QueryClient;
  routeErrorLifecycle: RouteErrorLifecycleController;
}>()({
  ssr: ({ location: routeLocation }) => isPublicSsrPath(routeLocation.pathname),
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
    links: [{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
  }),
  pendingComponent: () => <DefaultPendingComponent className="h-dvh" />,
  errorComponent: RootErrorComponent,
});

function RootErrorComponent(props: ErrorComponentProps) {
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
      <DefaultErrorComponent className="h-dvh" {...props} />
    </AppProviders>
  );
}

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
  const routeErrorLifecycle = Route.useRouteContext({
    select: (context) => context.routeErrorLifecycle,
  });
  const interfaceLocale = useI18nStore((s) => s.loadedLang);
  const hasLoadedOnce = useI18nStore((s) => s.hasLoadedOnce);
  const documentLanguage = useRouterState({
    select: (state) => pageDocumentLanguage(state.matches),
  });
  const lang = resolveDocumentLanguage({ documentLanguage, interfaceLocale });
  const dir = getLangDir(interfaceLocale);

  // Hydration keeps the attributes the server (or prepaint-init.js) put on
  // the element, so later locale loads and navigations are written here.
  // Until the first locale has loaded, the server markup and the prepaint
  // guess stand.
  useExternalSyncEffect(() => {
    if (!hasLoadedOnce) {
      return;
    }
    applyDocumentLanguage({ dir, lang });
  }, [dir, hasLoadedOnce, lang]);

  return (
    // prepaint-init.js mutates the html element's class, and for RTL
    // locales its lang/dir, before React hydrates the document, so the
    // attribute set never matches the server markup; suppress the
    // per-element warning rather than letting every SSR page log a
    // recovered hydration error. The server renders the document's own
    // language on pages that show one, and the interface locale otherwise.
    <html lang={lang} dir={dir} suppressHydrationWarning>
      <head>
        <HeadContent />

        <script src="/prepaint-init.js" />
      </head>
      <body>
        <RouteErrorLifecycleProvider controller={routeErrorLifecycle}>
          {children}
        </RouteErrorLifecycleProvider>
        <Scripts />
      </body>
    </html>
  );
}

function RootApp() {
  return (
    <div className="flex h-dvh w-full flex-col" id="app">
      <ApiVersionMismatchProvider>
        <Outlet />
        {DevRoot ? (
          <ClientOnly>
            <Suspense fallback={null}>
              <DevRoot />
            </Suspense>
          </ClientOnly>
        ) : null}
      </ApiVersionMismatchProvider>
    </div>
  );
}
