import { lazy, Suspense } from "react";
import type { ReactNode } from "react";

import type { QueryClient } from "@tanstack/react-query";
import {
  ClientOnly,
  createRootRouteWithContext,
  type ErrorComponentProps,
  HeadContent,
  Outlet,
  redirect,
  Scripts,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { panic } from "better-result";

import { cn } from "@stll/ui/utils";

import { AppProviders } from "@/app-providers";
import { ApiVersionMismatchProvider } from "@/components/api-version-mismatch-refresh";
import {
  DefaultErrorComponent,
  DefaultPendingComponent,
} from "@/components/route-components";
import { RouteProviderScopeBoundary } from "@/components/route-provider-scope/route-provider-scope";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { loadDocumentPresentation } from "@/i18n/document-presentation";
import {
  getLangDir,
  RenderedI18nStoreProvider,
  useI18nStore,
} from "@/i18n/i18n-store";
import "@/fonts.css";
import {
  applyDocumentLanguage,
  pageDocumentLanguage,
  resolveDocumentLanguage,
} from "@/i18n/page-language";
import { loadMcpHandoff, pendingHandoffPath } from "@/lib/account/mcp-handoff";
import type { PresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import { PresentationPrefsProvider } from "@/lib/account/presentation-prefs/provider";
import type { AnalyticsValue } from "@/lib/analytics/provider";
import type { RouteErrorLifecycleController } from "@/lib/analytics/route-error-lifecycle";
import { RouteErrorLifecycleProvider } from "@/lib/analytics/route-error-lifecycle-context";
import { detached } from "@/lib/detached";
import {
  isPublicKnowledgeCrawlAllowed,
  isPublicKnowledgeEnabled,
} from "@/lib/knowledge/public-knowledge-launch";
import { publicToolsBasePath } from "@/lib/knowledge/public-tools-path";
import { isPublicLawCrawlAllowed } from "@/lib/public-law-launch";
import { isPublicSsrPath } from "@/lib/public-ssr-paths";
import { isPublicToolsCrawlAllowed } from "@/lib/public-tools-launch";
import { requireFreshDocument } from "@/lib/session-cache-guard";
import { documentResponsePolicyHeaders } from "@/route-response-policy";
import { AppFrameHost } from "@/routes/-app-frame-host";
import { APP_FRAME_SCOPE } from "@/routes/-app-frame-scope";
import { requireProfessionalUseForSignedInRoute } from "@/routes/-auth-context";
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
  staticData: { appFrame: APP_FRAME_SCOPE.none },
  ssr: ({ location: routeLocation }) => isPublicSsrPath(routeLocation.pathname),
  beforeLoad: async ({ context, location }) => {
    const handoffRedirect = await loadMcpHandoff();
    if (handoffRedirect) {
      redirect({ ...handoffRedirect.options, throw: true });
      panic("TanStack Router did not throw the handoff redirect.");
    }
    await requireFreshDocument({ queryClient: context.queryClient, location });
    // Public SSR has no browser session. Caching its anonymous response would
    // keep signed-in member actions hidden after hydration.
    if (import.meta.env.SSR) {
      return {
        presentationPrefs: await loadDocumentPresentation(context.queryClient),
      };
    }
    // Development fixtures supply their own auth providers without an API.
    if (isDev && location.pathname === "/dev") {
      return {
        presentationPrefs: await loadDocumentPresentation(context.queryClient),
      };
    }
    await requireProfessionalUseForSignedInRoute({
      queryClient: context.queryClient,
      location,
    });
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
  const navigate = useNavigate();
  const router = useRouter();
  // Public documents reuse server route context during hydration. Re-enter
  // the browser guard after mounting so redirects stay in the router boundary.
  useMountEffect(() => {
    const href = pendingHandoffPath();
    if (href) {
      detached(
        navigate({
          href,
          replace: true,
        }),
        "mcp-handoff.route-entry",
      );
      return;
    }
    if (isPublicSsrPath(router.state.location.pathname)) {
      detached(
        navigate({
          href: router.state.location.publicHref,
          replace: true,
          resetScroll: false,
        }),
        "professional-use.route-entry",
      );
    }
  });
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

  // The system colour scheme alone depends on browser media queries.
  return (
    <RenderedI18nStoreProvider>
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

          <script src="/handoff-init.js" />
          <script src="/prepaint-init.js" />
        </head>
        <body>
          <RouteErrorLifecycleProvider controller={routeErrorLifecycle}>
            <RouteProviderScopeBoundary>
              <PresentationPrefsProvider initialPrefs={prefs}>
                {children}
              </PresentationPrefsProvider>
            </RouteProviderScopeBoundary>
          </RouteErrorLifecycleProvider>
          <Scripts />
        </body>
      </html>
    </RenderedI18nStoreProvider>
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
