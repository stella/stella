import { lazy, Suspense } from "react";
import type { ReactNode } from "react";

import type { QueryClient } from "@tanstack/react-query";
import {
  ClientOnly,
  createRootRouteWithContext,
  type ErrorComponentProps,
  HeadContent,
  isRedirect,
  Outlet,
  redirect,
  Scripts,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { panic, Result } from "better-result";

import { cn } from "@stll/ui/utils";

import { AppProviders } from "@/app-providers";
import { ApiVersionMismatchProvider } from "@/components/api-version-mismatch-refresh";
import {
  DefaultErrorComponent,
  DefaultNotFoundComponent,
  DefaultPendingComponent,
} from "@/components/route-components";
import { RouteProviderScopeBoundary } from "@/components/route-provider-scope/route-provider-scope";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { ClientDocumentPresentationBoot } from "@/i18n/client-document-presentation-boot";
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
import {
  getBrowserPresentationPrefs,
  PresentationPrefsProvider,
} from "@/lib/account/presentation-prefs/provider";
import type { AnalyticsValue } from "@/lib/analytics/provider";
import type { RouteErrorLifecycleController } from "@/lib/analytics/route-error-lifecycle";
import { RouteErrorLifecycleProvider } from "@/lib/analytics/route-error-lifecycle-context";
import { detached } from "@/lib/detached";
import {
  isPublicKnowledgeCrawlAllowed,
  isPublicKnowledgeEnabled,
} from "@/lib/knowledge/public-knowledge-launch";
import { publicToolsBasePath } from "@/lib/knowledge/public-tools-path";
import { sweepStaleRedirectRequests } from "@/lib/mcp-oauth-channel";
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
import "@/styles/print.css";

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
      return { presentationPrefs: getBrowserPresentationPrefs() };
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
  notFoundComponent: RootNotFoundComponent,
});

// Public documents hydrate from the anonymous server render and reuse its
// route context. Their browser guards run in place after mounting; only a
// redirect they raise navigates. Re-navigating to the same address instead
// would hold the route content dehydrated until the session read settles,
// and that content would then hydrate against state the server never had.
const enterPublicDocument = async ({
  router,
  queryClient,
}: {
  router: ReturnType<typeof useRouter>;
  queryClient: QueryClient;
}) => {
  const location = router.state.location;
  const entered = await Result.tryPromise(async () => {
    await requireFreshDocument({ queryClient, location });
    await requireProfessionalUseForSignedInRoute({ queryClient, location });
  });
  if (entered.isOk()) {
    return;
  }
  const { cause } = entered.error;
  if (!isRedirect(cause)) {
    throw cause;
  }
  await router.navigate({ ...cause.options, replace: true });
};

/**
 * A handoff captured before a server-rendered document hydrated is redeemed
 * in place for the same reason; only its outcome navigates.
 */
const enterHandoffDocument = async ({
  router,
  queryClient,
  href,
}: {
  router: ReturnType<typeof useRouter>;
  queryClient: QueryClient;
  href: string;
}) => {
  const handoffRedirect = await loadMcpHandoff();
  if (handoffRedirect) {
    await router.navigate({ ...handoffRedirect.options, replace: true });
    return;
  }
  if (isPublicSsrPath(router.state.location.pathname)) {
    await enterPublicDocument({ router, queryClient });
    return;
  }
  await router.navigate({ href, replace: true });
};

function RootNotFoundComponent() {
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
      <DefaultNotFoundComponent />
    </AppProviders>
  );
}

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
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const router = useRouter();
  const { analyticsValue, queryClient } = Route.useRouteContext({
    select: (context) => ({
      analyticsValue: context.analyticsValue,
      queryClient: context.queryClient,
    }),
  });
  // Public documents reuse server route context during hydration; their
  // browser guards run after mounting (see enterPublicDocument).
  useMountEffect(() => {
    sweepStaleRedirectRequests();
    const href = pendingHandoffPath();
    if (href) {
      detached(
        enterHandoffDocument({ router, queryClient, href }),
        "mcp-handoff.route-entry",
      );
      return;
    }
    if (isPublicSsrPath(router.state.location.pathname)) {
      detached(
        enterPublicDocument({ router, queryClient }),
        "professional-use.route-entry",
      );
    }
  });
  return (
    <AppProviders analyticsValue={analyticsValue} queryClient={queryClient}>
      {!(isDev && pathname === "/dev") && (
        <ClientDocumentPresentationBoot queryClient={queryClient} />
      )}
      <RootApp />
    </AppProviders>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  const nonce = useRouter().options.ssr?.nonce;
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

          <script nonce={nonce} src="/handoff-init.js" />
          <script nonce={nonce} src="/prepaint-init.js" />
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
