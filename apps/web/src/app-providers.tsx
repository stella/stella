import { useEffect } from "react";
import type { PropsWithChildren } from "react";

import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { IntlProvider } from "use-intl";

import { ToastProvider } from "@stll/ui/components/toast";
import { TooltipProvider } from "@stll/ui/components/tooltip";

import { DefaultPendingComponent } from "@/components/route-components";
import { ThemeProvider } from "@/components/theme-provider";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { useI18nStore } from "@/i18n/i18n-store";
import type Messages from "@/i18n/langs/messages.gen";
import { AnalyticsProvider, useAnalytics } from "@/lib/analytics/provider";
import type { AnalyticsValue } from "@/lib/analytics/provider";
import { isPublicSsrPath } from "@/lib/public-ssr-paths";

const SERVER_I18N_TIME_ZONE = "UTC";

const resolveAppI18nTimeZone = (): string => {
  if (typeof window === "undefined") {
    return SERVER_I18N_TIME_ZONE;
  }

  return Intl.DateTimeFormat().resolvedOptions().timeZone;
};

const I18nProvider = ({ children }: PropsWithChildren) => {
  const locale = useI18nStore((s) => s.loadedLang);
  const messages = useI18nStore((s) => s.messages);
  const hasLoadedOnce = useI18nStore((s) => s.hasLoadedOnce);

  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  // Gate the boot spinner on the first load, not on isLoaded: a language
  // switch flips isLoaded false while the new locale streams in, and gating
  // the whole subtree on it would unmount the app (losing in-progress state
  // like onboarding) on every switch. loadedLang/messages are always a
  // consistent already-loaded pair, so the locale swaps in place instead.
  //
  // Server-rendered public paths must skip the spinner entirely: the
  // server renders full content, so the client's first render has to
  // produce identical markup or hydration fails. Both sides render the
  // statically bundled English there, and the persisted locale swaps in
  // place after mount.
  if (
    !hasLoadedOnce &&
    typeof window !== "undefined" &&
    !isPublicSsrPath(pathname)
  ) {
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
      timeZone={resolveAppI18nTimeZone()}
    >
      {children}
    </IntlProvider>
  );
};

const AnalyticsAuthIdentity = () => {
  const analytics = useAnalytics();
  const authStatus = useClientAuthStatus();

  useEffect(() => {
    if (authStatus.status === "checking") {
      return;
    }

    if (authStatus.status === "anonymous") {
      analytics.reset({ onlyIfIdentified: true });
      return;
    }

    analytics.identifyUser({
      email: authStatus.user.email,
      id: authStatus.user.id,
      ...(authStatus.user.name === undefined
        ? {}
        : { name: authStatus.user.name }),
    });
  }, [analytics, authStatus]);

  return null;
};

export const AppProviders = ({
  analyticsValue,
  children,
  queryClient,
}: PropsWithChildren<{
  analyticsValue: AnalyticsValue;
  queryClient: QueryClient;
}>) => (
  <QueryClientProvider client={queryClient}>
    <AnalyticsProvider value={analyticsValue}>
      <AnalyticsAuthIdentity />
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
  </QueryClientProvider>
);
