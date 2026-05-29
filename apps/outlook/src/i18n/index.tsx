import type { PropsWithChildren } from "react";

import { IntlProvider } from "use-intl";
import { createTranslator } from "use-intl/core";

import { en, supportedLanguages, type SupportedLanguage } from "@stll/i18n";

const supportedSet: ReadonlySet<string> = new Set(supportedLanguages);

const isSupportedLanguage = (value: string): value is SupportedLanguage =>
  supportedSet.has(value);

const detectLanguage = (): SupportedLanguage => {
  const languages =
    typeof navigator !== "undefined" && "languages" in navigator
      ? navigator.languages
      : [];

  for (const candidate of languages) {
    const prefix = candidate.split("-").at(0) ?? candidate;
    if (isSupportedLanguage(prefix)) {
      return prefix;
    }
  }

  return "en";
};

export const detectedLanguage = detectLanguage();

export const translator = createTranslator({
  locale: detectedLanguage,
  messages: en,
});

export const OutlookIntlProvider = ({ children }: PropsWithChildren) => (
  <IntlProvider
    locale={detectedLanguage}
    messages={en}
    timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
  >
    {children}
  </IntlProvider>
);
