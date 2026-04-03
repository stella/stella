import { createTranslator } from "use-intl/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { getStorageKey } from "@/consts";
import cs from "@/i18n/langs/cs.json";
import de from "@/i18n/langs/de.json";
import en from "@/i18n/langs/en.json";
import es from "@/i18n/langs/es.json";
import et from "@/i18n/langs/et.json";
import fr from "@/i18n/langs/fr.json";
import hu from "@/i18n/langs/hu.json";
import lt from "@/i18n/langs/lt.json";
import lv from "@/i18n/langs/lv.json";
import pl from "@/i18n/langs/pl.json";
import sk from "@/i18n/langs/sk.json";

export const langMessages = {
  en,
  cs,
  de,
  es,
  et,
  fr,
  hu,
  lt,
  lv,
  pl,
  sk,
} as const;

type SupportedLanguage = keyof typeof langMessages;

// SAFETY: langMessages keys are SupportedLanguage; Object.keys preserves them
// eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
export const supportedLanguages = Object.keys(
  langMessages,
) as SupportedLanguage[];

export const LANG_ENDONYMS = {
  en: "English",
  cs: "Čeština",
  de: "Deutsch",
  es: "Español",
  et: "Eesti",
  fr: "Français",
  hu: "Magyar",
  lt: "Lietuvių",
  lv: "Latviešu",
  pl: "Polski",
  sk: "Slovenčina",
} as const satisfies Record<SupportedLanguage, string>;

const isSupportedLanguage = (value: string): value is SupportedLanguage =>
  value in langMessages;

const detectLang = (): SupportedLanguage => {
  const languages =
    typeof navigator !== "undefined" && "languages" in navigator
      ? navigator.languages
      : [];

  for (const candidate of languages) {
    const prefix = candidate.split("-")[0] ?? candidate;
    if (isSupportedLanguage(prefix)) {
      return prefix;
    }
  }

  return "en";
};

const defaultLanguage = detectLang();

let translator = createTranslator({
  locale: defaultLanguage,
  messages: langMessages[defaultLanguage],
});

export const getTranslator = () => translator;

type State = {
  lang: SupportedLanguage;
};

type Actions = {
  setLang: (lang: SupportedLanguage) => void;
};

export const useI18nStore = create<State & Actions>()(
  persist(
    (set) => ({
      lang: defaultLanguage,
      setLang: (lang) => {
        document.documentElement.lang = lang;

        translator = createTranslator({
          locale: lang,
          messages: langMessages[lang],
        });

        set({ lang });
      },
    }),
    {
      name: getStorageKey("i18n"),
      version: 0,
      migrate: () => {
        /* no-op: reset persisted state on version bump */
      },
      onRehydrateStorage: () => (state) => {
        if (!state) {
          return;
        }

        document.documentElement.lang = state.lang;
        translator = createTranslator({
          locale: state.lang,
          messages: langMessages[state.lang],
        });
      },
    },
  ),
);
