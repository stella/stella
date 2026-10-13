import { useRef } from "react";
import type { PropsWithChildren } from "react";

import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { panic } from "better-result";
import { IntlProvider, useTranslations } from "use-intl";

import { DialogProvider } from "@stll/ui/dialog";
import { ToastProvider } from "@stll/ui/toast";
import { TooltipProvider } from "@stll/ui/tooltip";

import { WebReaderPresentationProvider } from "@/components/legal-reader/web-reader-presentation";
import { ThemeProvider } from "@/components/theme-provider";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { FormattingProvider } from "@/i18n/formatting-context";
import {
  buildFormattingLocale,
  synchronizeFormatterTimeZone,
  useI18nStore,
} from "@/i18n/i18n-store";
import { useHydrationSafeTimeZone } from "@/i18n/time-zone";
import { AnalyticsProvider } from "@/lib/analytics/analytics-provider";
import { useAnalytics } from "@/lib/analytics/provider";
import type { AnalyticsValue } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { isPublicSsrPath } from "@/lib/public-ssr-paths";

const DialogTranslations = ({ children }: PropsWithChildren) => {
  const t = useTranslations();
  return (
    <DialogProvider
      labels={{
        close: t("common.close"),
        unsavedChanges: t("common.unsavedChangesEscape"),
      }}
    >
      {children}
    </DialogProvider>
  );
};

const I18nProvider = ({ children }: PropsWithChildren) => {
  const locale = useI18nStore((s) => s.loadedLang);
  const messages = useI18nStore((s) => s.messages);
  const region = useI18nStore((s) => s.region);
  const regionalFormat = useI18nStore((s) => s.regionalFormat);
  const calendar = useI18nStore((s) => s.calendar);
  const numberingSystem = useI18nStore((s) => s.numberingSystem);
  const weekStart = useI18nStore((s) => s.weekStart);
  const timeZone = useHydrationSafeTimeZone(synchronizeFormatterTimeZone);

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

  const formattingLocale = buildFormattingLocale({
    lang: locale,
    region,
    regionalFormat,
    calendar,
    numberingSystem,
    weekStart,
  });

  return (
    <IntlProvider locale={locale} messages={messages} timeZone={timeZone}>
      <FormattingProvider locale={formattingLocale} timeZone={timeZone}>
        <DialogTranslations>{children}</DialogTranslations>
      </FormattingProvider>
    </IntlProvider>
  );
};

const AnalyticsAuthIdentity = () => {
  const analytics = useAnalytics();
  const authStatus = useClientAuthStatus();

  useExternalSyncEffect(() => {
    switch (authStatus.status) {
      // An unknown session keeps whatever identity analytics already holds.
      case "checking":
      case "unavailable":
        return;
      case "anonymous":
        analytics.reset({ onlyIfIdentified: true });
        return;
      case "authenticated":
        analytics.identifyUser({
          id: authStatus.user.id,
          activeOrganizationId: authStatus.user.activeOrganizationId,
        });
        return;
      default:
        authStatus satisfies never;
        panic(`Unhandled session status: ${String(authStatus)}`);
    }
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
              <ToastProvider>
                <WebReaderPresentationProvider>
                  {children}
                </WebReaderPresentationProvider>
              </ToastProvider>
            </TooltipProvider>
          </ThemeProvider>
        </HotkeysProvider>
      </I18nProvider>
    </AnalyticsProvider>
  </QueryClientProvider>
);
