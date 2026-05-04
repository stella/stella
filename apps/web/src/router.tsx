import type { PropsWithChildren } from "react";

import { ToastProvider } from "@stll/ui/components/toast";
import { TooltipProvider } from "@stll/ui/components/tooltip";
import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { enableMapSet } from "immer";
import { IntlProvider } from "use-intl";

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
  const lang = useI18nStore((s) => s.lang);
  const messages = useI18nStore((s) => s.messages);
  const isLoaded = useI18nStore((s) => s.isLoaded);

  if (!isLoaded) {
    return <DefaultPendingComponent />;
  }

  return (
    <IntlProvider
      locale={lang}
      // SAFETY: locale JSON files are shape-checked in i18n-store.ts;
      // this cast is only at the provider boundary because use-intl's
      // Messages type preserves English literal message values while
      // translated locale JSONs necessarily contain different strings.
      // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
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
    // that resolve in under 200ms never show a loading state; when
    // the spinner does appear, keep it visible for at least 500ms
    // to avoid flicker when the loader completes just after the
    // threshold.
    defaultPendingMs: 200,
    defaultPendingMinMs: 500,
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
      href: toLocation.href,
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
