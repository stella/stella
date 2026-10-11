import { createTranslator } from "use-intl";

import { normalizeLocale } from "@stll/agent-input";
import { getUiLocaleDirection, resolveUiLocale } from "@stll/locales";

import messages from "./generated/messages.json";

export const appLocale = (hostLocale: string | undefined) => {
  const canonical = normalizeLocale(hostLocale ?? "en");
  const formattingLocale = canonical.ok ? canonical.value : "en";
  const locale = resolveUiLocale(formattingLocale) ?? "en";
  return {
    locale,
    // Preserve regional and Unicode numbering-system preferences for formatters.
    formattingLocale,
    direction: getUiLocaleDirection(locale),
    messages: messages[locale],
    t: createTranslator({
      locale: formattingLocale,
      messages: messages[locale],
    }),
  };
};

export type AppMessageKey = keyof typeof messages.en;

export const isAppMessageKey = (key: string): key is AppMessageKey =>
  Object.hasOwn(messages.en, key);
