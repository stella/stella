import { useRef, useSyncExternalStore } from "react";
import type { PropsWithChildren } from "react";

import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { IntlProvider } from "use-intl";

import { ToastProvider } from "@stll/ui/components/toast";
import { TooltipProvider } from "@stll/ui/components/tooltip";

import { DefaultPendingComponent } from "@/components/route-components";
import { ThemeProvider } from "@/components/theme-provider";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import {
  buildFormattingLocale,
  bundledEnglishMessages,
  useI18nStore,
} from "@/i18n/i18n-store";
import type Messages from "@/i18n/langs/messages.gen";
import { resolveAppTimeZone } from "@/i18n/time-zone";
import { AnalyticsProvider, useAnalytics } from "@/lib/analytics/provider";
import type { AnalyticsValue } from "@/lib/analytics/provider";
import { isPublicSsrPath } from "@/lib/public-ssr-paths";

const noopSubscribe = () => () => undefined;

/**
 * False during server render AND the client's hydration pass, true
 * immediately after. The canonical hydration-safe two-phase signal:
 * useSyncExternalStore serves getServerSnapshot to both sides of
 * hydration, so flipping to true afterwards is an ordinary update, not
 * a markup mismatch.
 */
const useHydrated = (): boolean =>
  useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );

const I18nProvider = ({ children }: PropsWithChildren) => {
  const locale = useI18nStore((s) => s.loadedLang);
  const messages = useI18nStore((s) => s.messages);
  const hasLoadedOnce = useI18nStore((s) => s.hasLoadedOnce);
  const region = useI18nStore((s) => s.region);
  const calendar = useI18nStore((s) => s.calendar);
  const numberingSystem = useI18nStore((s) => s.numberingSystem);
  const weekStart = useI18nStore((s) => s.weekStart);
  const hydrated = useHydrated();

  // window.location is safe here: the server branch never reads it, and
  // on the client the gate only matters for the initial document load.
  const onPublicSsrPath =
    typeof window !== "undefined" && isPublicSsrPath(window.location.pathname);

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
    void router.invalidate();
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
  if (!hasLoadedOnce && typeof window !== "undefined" && !onPublicSsrPath) {
    return <DefaultPendingComponent />;
  }

  // On those same paths the client may already hold the persisted
  // locale before hydration (client.tsx awaits initializeI18n first),
  // so render the bundled English the server used until hydration
  // completes; the persisted locale then swaps in place.
  const preHydrationEnglish = onPublicSsrPath && !hydrated;

  // SAFETY: locale JSON files are shape-checked in i18n-store.ts; this
  // cast is only at the provider boundary because use-intl's Messages
  // type preserves English literal message values while translated
  // locale JSONs necessarily contain different strings.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- i18n provider boundary; locale JSON shape-checked in i18n-store, use-intl's Messages keeps English literal values
  const activeMessages = (
    preHydrationEnglish ? bundledEnglishMessages : messages
  ) as Messages;

  // Plurals and message lookup key off the base language; the -u- extensions
  // only steer number/date formatting. preHydrationEnglish forces the plain
  // English tag so client markup matches the server's.
  const formattingLocale = preHydrationEnglish
    ? "en"
    : buildFormattingLocale({
        lang: locale,
        region,
        calendar,
        numberingSystem,
        weekStart,
      });

  return (
    <IntlProvider
      locale={formattingLocale}
      messages={activeMessages}
      timeZone={resolveAppTimeZone()}
    >
      {children}
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
