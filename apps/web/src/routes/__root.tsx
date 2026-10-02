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
import {
  applyDocumentLanguage,
  pageDocumentLanguage,
  resolveDocumentLanguage,
} from "@/i18n/page-language";
import "@/fonts.css";
import type { AnalyticsValue } from "@/lib/analytics/provider";
import type { RouteErrorLifecycleController } from "@/lib/analytics/route-error-lifecycle";
import { RouteErrorLifecycleProvider } from "@/lib/analytics/route-error-lifecycle-context";
import {
  isPublicKnowledgeEnabled,
  isPublicKnowledgeCrawlAllowed,
} from "@/lib/knowledge/public-knowledge-launch";
import { publicToolsBasePath } from "@/lib/knowledge/public-tools-path";
import { isPublicLawCrawlAllowed } from "@/lib/public-law-launch";
import { isPublicSsrPath } from "@/lib/public-ssr-paths";
import { isPublicToolsCrawlAllowed } from "@/lib/public-tools-launch";
import { requireFreshDocument } from "@/lib/session-cache-guard";
import { documentResponsePolicyHeaders } from "@/route-response-policy";
import { AppFrameHost } from "@/routes/-app-frame-host";
import { createRootHead } from "@/routes/-root-head";
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
  beforeLoad: async ({ context, location }) => {
    await requireFreshDocument({ queryClient: context.queryClient, location });
  },
  shellComponent: RootDocument,
  component: RootComponent,
  // Document head management via route `head` option.
  // https://tanstack.com/router/latest/docs/framework/react/guide/document-head-management
  head: () => createRootHead(isPublicKnowledgeEnabled()),
  headers: ({ matches }) =>
    documentResponsePolicyHeaders({
      match: matches.at(-1),
      crawl: {
        publicKnowledgeCrawlAllowed: isPublicKnowledgeCrawlAllowed(),
        publicLawCrawlAllowed: isPublicLawCrawlAllowed(),
        publicToolsCrawlAllowed: isPublicToolsCrawlAllowed(),
        toolsBasePath: publicToolsBasePath(),
      },
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
  const { lang, source: langSource } = resolveDocumentLanguage({
    documentLanguage,
    interfaceLocale,
  });
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
    // language on pages that show one, and the interface locale otherwise;
    // data-lang-source tells prepaint-init.js to keep a document language.
    <html
      lang={lang}
      dir={dir}
      data-lang-source={langSource}
      suppressHydrationWarning
    >
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
        <AppFrameHost>
          <Outlet />
        </AppFrameHost>
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
