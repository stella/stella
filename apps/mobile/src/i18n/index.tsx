import { IntlProvider } from "use-intl";

import { resolveUiLocale } from "@stll/locales";
import type { UiLocale } from "@stll/locales";

import { CATALOGS } from "@/i18n/catalogs";

/**
 * The device's language when stella ships it, else English. Read once at
 * start: a language change in system settings restarts the app on both
 * platforms.
 */
const deviceLocale = (): UiLocale =>
  resolveUiLocale(Intl.DateTimeFormat().resolvedOptions().locale) ?? "en";

const locale = deviceLocale();
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export const MobileIntlProvider = ({ children }: React.PropsWithChildren) => (
  <IntlProvider locale={locale} messages={CATALOGS[locale]} timeZone={timeZone}>
    {children}
  </IntlProvider>
);
