import { useRef } from "react";
import type { PropsWithChildren } from "react";

import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { IntlProvider } from "use-intl";

import { ToastProvider } from "@stll/ui/components/toast";
import { TooltipProvider } from "@stll/ui/components/tooltip";

import { DefaultPendingComponent } from "@/components/route-components";
import { ThemeProvider } from "@/components/theme-provider";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useHydrated } from "@/hooks/use-hydrated";
import { FormattingProvider } from "@/i18n/formatting-context";
import {
  buildFormattingLocale,
  bundledEnglishMessages,
  useI18nStore,
} from "@/i18n/i18n-store";
import { useHydrationSafeTimeZone } from "@/i18n/time-zone";
import { AnalyticsProvider } from "@/lib/analytics/analytics-provider";
import { useAnalytics } from "@/lib/analytics/provider";
import type { AnalyticsValue } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { isPublicSsrPath } from "@/lib/public-ssr-paths";

const I18nProvider = ({ children }: PropsWithChildren) => {
  const locale = useI18nStore((s) => s.loadedLang);
  const messages = useI18nStore((s) => s.messages);
  const hasLoadedOnce = useI18nStore((s) => s.hasLoadedOnce);
  const region = useI18nStore((s) => s.region);
  const regionalFormat = useI18nStore((s) => s.regionalFormat);
  const calendar = useI18nStore((s) => s.calendar);
  const numberingSystem = useI18nStore((s) => s.numberingSystem);
  const weekStart = useI18nStore((s) => s.weekStart);
  const hydrated = useHydrated();
  const timeZone = useHydrationSafeTimeZone();

  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const onPublicSsrPath = isPublicSsrPath(pathname);

  // Head content (the document title) renders outside this provider and
  // only re-evaluates on router invalidation; refresh it when a new
  // locale finishes loading post-hydration so the title localizes
  // without a navigation. Ref-guarded to locale CHANGES so the initial
  // mount does not re-run route loaders.
  const router = useRouter();
  const previousLocaleRef = useRef(locale);
  useExternalSyncEffect(() => {
    if (!onPublicSsrPath || previousLocaleRef.current === locale) {
      return;
    }
    previousLocaleRef.current = locale;
    detached(router.invalidate(), "app-providers.locale-change");
  }, [router, locale, onPublicSsrPath]);

  // Gate the boot spinner on the first load, not on isLoaded: a language
  // switch flips isLoaded false while the new locale streams in, and gating
  // the whole subtree on it would unmount the app (losing in-progress state
  // like onboarding) on every switch. loadedLang/messages are always a
  // consistent already-loaded pair, so the locale swaps in place instead.
  //
  // Server-rendered public paths must skip the spinner entirely: the
  // server renders full content, so the client's first render has to
  // produce identical markup or hydration fails.
  if (!hasLoadedOnce && !onPublicSsrPath) {
    return <DefaultPendingComponent />;
  }

  // On those same paths the client may already hold the persisted
  // locale before hydration (client.tsx awaits initializeI18n first),
  // so render the bundled English the server used until hydration
  // completes; the persisted locale then swaps in place.
  const preHydrationEnglish = onPublicSsrPath && !hydrated;

  const activeMessages = preHydrationEnglish
    ? bundledEnglishMessages
    : messages;

  // Plurals and message lookup key off the base language; the -u- extensions
  // only steer number/date formatting. preHydrationEnglish forces the plain
  // English tag so client markup matches the server's.
  const formattingLocale = preHydrationEnglish
    ? "en"
    : buildFormattingLocale({
        lang: locale,
        region,
        regionalFormat,
        calendar,
        numberingSystem,
        weekStart,
      });

  const messageLocale = preHydrationEnglish ? "en" : locale;

  return (
    <IntlProvider
      locale={messageLocale}
      messages={activeMessages}
      timeZone={timeZone}
    >
      <FormattingProvider locale={formattingLocale} timeZone={timeZone}>
        {children}
      </FormattingProvider>
    </IntlProvider>
  );
};

const AnalyticsAuthIdentity = () => {
  const analytics = useAnalytics();
  const authStatus = useClientAuthStatus();

  useExternalSyncEffect(() => {
    if (authStatus.status === "checking") {
      return;
    }

    if (authStatus.status === "anonymous") {
      analytics.reset({ onlyIfIdentified: true });
      return;
    }

    analytics.identifyUser({ id: authStatus.user.id });
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
