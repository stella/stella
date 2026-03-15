import type { PropsWithChildren } from "react";

import { PostHogProvider } from "@posthog/react";
import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { enableMapSet } from "immer";
import { IntlProvider } from "use-intl";
import type { AbstractIntlMessages } from "use-intl";

import { ToastProvider } from "@stella/ui/components/toast";
import { TooltipProvider } from "@stella/ui/components/tooltip";

import {
  DefaultErrorComponent,
  DefaultNotFoundComponent,
  DefaultPendingComponent,
} from "@/components/route-components";
import { ThemeProvider } from "@/components/theme-provider";
import { langMessages, useI18nStore } from "@/i18n/i18n-store";
import { STALE_TIME } from "@/lib/consts";
import initializePosthog from "@/lib/posthog/client";
import { routeTree } from "@/routeTree.gen";

enableMapSet();

const I18nProvider = ({ children }: PropsWithChildren) => {
  const lang = useI18nStore((s) => s.lang);
  const messages: AbstractIntlMessages = langMessages[lang];

  return (
    <IntlProvider
      locale={lang}
      messages={messages}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      {children}
    </IntlProvider>
  );
};

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME.FIVE.MINUTES,
      },
    },
  });
  const posthog = initializePosthog();

  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    context: { queryClient },
    scrollRestoration: true,
    defaultNotFoundComponent: DefaultNotFoundComponent,
    defaultErrorComponent: DefaultErrorComponent,
    defaultPendingComponent: DefaultPendingComponent,
    defaultPendingMs: 0,
    Wrap: ({ children }) => (
      <PostHogProvider client={posthog}>
        <I18nProvider>
          <HotkeysProvider>
            <ThemeProvider>
              <TooltipProvider>
                <ToastProvider>{children}</ToastProvider>
              </TooltipProvider>
            </ThemeProvider>
          </HotkeysProvider>
        </I18nProvider>
      </PostHogProvider>
    ),
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
