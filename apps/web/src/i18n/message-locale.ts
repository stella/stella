import { panic } from "better-result";
import { useLocale } from "use-intl";

import { isUiLocale } from "@stll/locales";

import type { SupportedLanguage } from "@/i18n/i18n-store";

/**
 * The UI language: the locale IntlProvider renders messages in, for language
 * choices such as a document's or an answer's language. Numbers, dates and
 * collation follow the reader's formatting locale instead, read with
 * `useFormattingLocale` from `@/i18n/formatting-context`; the two differ
 * whenever the reader picks a regional format.
 */
export const useMessageLocale = (): SupportedLanguage => {
  const locale = useLocale();
  if (!isUiLocale(locale)) {
    panic("IntlProvider must be given a supported UI language", { locale });
  }
  return locale;
};
