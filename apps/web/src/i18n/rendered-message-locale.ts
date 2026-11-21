import { buildMessageLocale, useI18nStore } from "@/i18n/i18n-store";
import { usePresentationPrefs } from "@/lib/account/presentation-prefs/provider";

/**
 * The locale `I18nProvider` renders messages in (the UI language with the
 * reader's digits), for a nested provider whose plurals must agree with it.
 * Built by the same `buildMessageLocale` from the same preferences; kept out
 * of the provider so the initial bundle does not carry it.
 */
export const useRenderedMessageLocale = (): string => {
  const { prefs } = usePresentationPrefs();
  const lang = useI18nStore((state) => state.loadedLang);
  return buildMessageLocale({
    lang,
    region: prefs.region,
    regionalFormat: prefs.regionalFormat,
    numberingSystem: prefs.numberingSystem,
  });
};
