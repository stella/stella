import type { PropsWithChildren } from "react";

import { IntlProvider, useTranslations } from "use-intl";

import { DialogProvider } from "@stll/ui/dialog";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { FormattingProvider } from "@/i18n/formatting-context";
import {
  buildFormattingLocale,
  synchronizeFormattingPreferences,
  synchronizeFormatterTimeZone,
  useI18nStore,
} from "@/i18n/i18n-store";
import { useHydrationSafeTimeZone } from "@/i18n/time-zone";
import { usePresentationPrefs } from "@/lib/account/presentation-prefs/provider";

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

export const I18nProvider = ({ children }: PropsWithChildren) => {
  const { prefs } = usePresentationPrefs();
  const locale = useI18nStore((s) => s.loadedLang);
  const messages = useI18nStore((s) => s.messages);
  const region = useI18nStore((s) => s.region);
  const regionalFormat = useI18nStore((s) => s.regionalFormat);
  const calendar = useI18nStore((s) => s.calendar);
  const numberingSystem = useI18nStore((s) => s.numberingSystem);
  const weekStart = useI18nStore((s) => s.weekStart);
  const timeZone = useHydrationSafeTimeZone(synchronizeFormatterTimeZone);

  useExternalSyncEffect(
    () =>
      synchronizeFormattingPreferences({
        calendar: prefs.calendar,
        numberingSystem: prefs.numberingSystem,
        region: prefs.region,
        regionalFormat: prefs.regionalFormat,
        weekStart: prefs.weekStart,
      }),
    [
      prefs.calendar,
      prefs.numberingSystem,
      prefs.region,
      prefs.regionalFormat,
      prefs.weekStart,
    ],
  );

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
