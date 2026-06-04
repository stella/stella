import type { PropsWithChildren } from "react";

import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { enableMapSet } from "immer";
import { IntlProvider } from "use-intl";

import { ToastProvider } from "@stll/ui/components/toast";
import { TooltipProvider } from "@stll/ui/components/tooltip";

import {
  DefaultErrorComponent,
  DefaultNotFoundComponent,
  DefaultPendingComponent,
} from "@/components/route-components";
import { ThemeProvider } from "@/components/theme-provider";
import { useI18nStore } from "@/i18n/i18n-store";
import type Messages from "@/i18n/langs/messages.gen";
import {
  AnalyticsProvider,
  createAnalyticsValue,
} from "@/lib/analytics/provider";
import { STALE_TIME } from "@/lib/consts";
import { installPDFDocumentCleanup } from "@/lib/pdf/hooks/use-pdf-document";
import { routeTree } from "@/routeTree.gen";

enableMapSet();

const I18nProvider = ({ children }: PropsWithChildren) => {
  const locale = useI18nStore((s) => s.loadedLang);
  const messages = useI18nStore((s) => s.messages);
  const hasLoadedOnce = useI18nStore((s) => s.hasLoadedOnce);

  // Gate the boot spinner on the first load, not on isLoaded: a language
  // switch flips isLoaded false while the new locale streams in, and gating
  // the whole subtree on it would unmount the app (losing in-progress state
  // like onboarding) on every switch. loadedLang/messages are always a
  // consistent already-loaded pair, so the locale swaps in place instead.
  if (!hasLoadedOnce) {
    return <DefaultPendingComponent />;
  }

  return (
    <IntlProvider
      locale={locale}
      // SAFETY: locale JSON files are shape-checked in i18n-store.ts;
      // this cast is only at the provider boundary because use-intl's
      // Messages type preserves English literal message values while
      // translated locale JSONs necessarily contain different strings.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      messages={messages as Messages}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      {children}
    </IntlProvider>
  );
};

export function getRouter() {
  const analyticsValue = createAnalyticsValue();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME.FIVE.MINUTES,
      },
    },
  });
  installPDFDocumentCleanup(queryClient);

  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    context: { queryClient },
    scrollRestoration: true,
    defaultNotFoundComponent: DefaultNotFoundComponent,
    defaultErrorComponent: DefaultErrorComponent,
    defaultPendingComponent: DefaultPendingComponent,
    // Don't flash the pending spinner on fast navigations. Routes
    // that resolve in under 500ms never show a loading state; when
    // the spinner does appear, keep it visible for at least 300ms
    // to avoid flicker when the loader completes just after the
    // threshold.
    defaultPendingMs: 500,
    defaultPendingMinMs: 300,
    Wrap: ({ children }) => (
      <AnalyticsProvider value={analyticsValue}>
        <I18nProvider>
          <HotkeysProvider
            defaultOptions={{
              hotkey: { conflictBehavior: "allow" },
            }}
          >
            <ThemeProvider>
              <TooltipProvider>
                <ToastProvider>{children}</ToastProvider>
              </TooltipProvider>
            </ThemeProvider>
          </HotkeysProvider>
        </I18nProvider>
      </AnalyticsProvider>
    ),
  });

  router.subscribe("onResolved", ({ toLocation }) => {
    analyticsValue.analytics.capturePageViewed({
      path: toLocation.pathname,
    });
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
  });

  return router;
}

declare module "@tanstack/react-router" {
  // oxlint-disable-next-line consistent-type-definitions
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
