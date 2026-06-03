import type { PropsWithChildren } from "react";

import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { IntlProvider } from "use-intl";

import { ToastProvider } from "@stll/ui/components/toast";
import { TooltipProvider } from "@stll/ui/components/tooltip";

import { DefaultPendingComponent } from "@/components/route-components";
import { ThemeProvider } from "@/components/theme-provider";
import { useI18nStore } from "@/i18n/i18n-store";
import type Messages from "@/i18n/langs/messages.gen";
import { AnalyticsProvider } from "@/lib/analytics/provider";
import type { AnalyticsValue } from "@/lib/analytics/provider";

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
