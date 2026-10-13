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

import { cn } from "@stll/ui/utils";

import { AppProviders } from "@/app-providers";
import { ApiVersionMismatchProvider } from "@/components/api-version-mismatch-refresh";
import {
  DefaultErrorComponent,
  DefaultPendingComponent,
} from "@/components/route-components";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { loadDocumentPresentation } from "@/i18n/document-presentation";
import { getLangDir, useI18nStore } from "@/i18n/i18n-store";
import "@/fonts.css";
import {
  applyDocumentLanguage,
  pageDocumentLanguage,
  resolveDocumentLanguage,
} from "@/i18n/page-language";
import type { AnalyticsValue } from "@/lib/analytics/provider";
import type { RouteErrorLifecycleController } from "@/lib/analytics/route-error-lifecycle";
import { RouteErrorLifecycleProvider } from "@/lib/analytics/route-error-lifecycle-context";
import {
  isPublicKnowledgeEnabled,
  isPublicKnowledgeCrawlAllowed,
} from "@/lib/knowledge/public-knowledge-launch";
import { publicToolsBasePath } from "@/lib/knowledge/public-tools-path";
import type { PresentationPrefs } from "@/lib/presentation-prefs";
import { PresentationPrefsProvider } from "@/lib/presentation-prefs-provider";
import { isPublicLawCrawlAllowed } from "@/lib/public-law-launch";
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
  presentationPrefs: PresentationPrefs;
  routeErrorLifecycle: RouteErrorLifecycleController;
}>()({
  ssr: true,
  beforeLoad: async ({ context, location }) => {
    await requireFreshDocument({ queryClient: context.queryClient, location });
    return {
      presentationPrefs: await loadDocumentPresentation(context.queryClient),
    };
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
  const prefs = Route.useRouteContext({
    select: (context) => context.presentationPrefs,
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

  // Synchronize later language changes and navigations with the document.
  useExternalSyncEffect(() => {
    if (!hasLoadedOnce) {
      return;
    }
    applyDocumentLanguage({ dir, lang });
  }, [dir, hasLoadedOnce, lang]);

  return (
    // The system colour scheme alone depends on browser media queries.
    <html
      className={cn(
        prefs.theme === "dark" && "dark",
        prefs.palette !== "neutral" && `palette-${prefs.palette}`,
      )}
      data-theme={prefs.theme}
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
          <PresentationPrefsProvider initialPrefs={prefs}>
            {children}
          </PresentationPrefsProvider>
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
