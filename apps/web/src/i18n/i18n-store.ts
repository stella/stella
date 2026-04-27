import { createTranslator } from "use-intl/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { getStorageKey } from "@/consts";
import en from "@/i18n/langs/en.json";
import type Messages from "@/i18n/langs/messages.gen";

type LocalizedMessages<T> = {
  [K in keyof T]: T[K] extends string ? string : LocalizedMessages<T[K]>;
};

export const supportedLanguages = [
  "en",
  "cs",
  "de",
  "es",
  "et",
  "fr",
  "hu",
  "lt",
  "lv",
  "pl",
  "sk",
] as const;

export type SupportedLanguage = (typeof supportedLanguages)[number];
type LocaleMessages = LocalizedMessages<Messages>;
type MessageLoader = () => LocaleMessages | Promise<LocaleMessages>;

const supportedLanguageSet: ReadonlySet<string> = new Set(supportedLanguages);

const messageLoaders = {
  en: () => en,
  cs: async () => (await import("@/i18n/langs/cs.json")).default,
  de: async () => (await import("@/i18n/langs/de.json")).default,
  es: async () => (await import("@/i18n/langs/es.json")).default,
  et: async () => (await import("@/i18n/langs/et.json")).default,
  fr: async () => (await import("@/i18n/langs/fr.json")).default,
  hu: async () => (await import("@/i18n/langs/hu.json")).default,
  lt: async () => (await import("@/i18n/langs/lt.json")).default,
  lv: async () => (await import("@/i18n/langs/lv.json")).default,
  pl: async () => (await import("@/i18n/langs/pl.json")).default,
  sk: async () => (await import("@/i18n/langs/sk.json")).default,
} as const satisfies Record<SupportedLanguage, MessageLoader>;

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
  supportedLanguageSet.has(value);

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
const defaultMessages = en;

let translator = createTranslator({
  locale: "en",
  messages: defaultMessages,
});

export const getTranslator = () => translator;

type State = {
  lang: SupportedLanguage;
  messages: LocaleMessages;
  loadedLang: SupportedLanguage;
  isLoaded: boolean;
};

type Actions = {
  setLang: (lang: SupportedLanguage) => Promise<void>;
  loadMessages: (lang: SupportedLanguage) => Promise<void>;
};

let loadRequestId = 0;

const setDocumentLanguage = (lang: SupportedLanguage): void => {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.lang = lang;
};

const applyMessages = (
  lang: SupportedLanguage,
  messages: LocaleMessages,
): void => {
  translator = createTranslator({
    locale: lang,
    messages,
  });
  setDocumentLanguage(lang);
};

export const useI18nStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      lang: defaultLanguage,
      messages: defaultMessages,
      loadedLang: "en",
      isLoaded: defaultLanguage === "en",

      loadMessages: async (lang) => {
        const state = get();
        if (state.loadedLang === lang && state.isLoaded) {
          set({ lang });
          setDocumentLanguage(lang);
          return;
        }

        const requestId = (loadRequestId += 1);
        set({ lang, isLoaded: false });

        let messages: LocaleMessages;
        try {
          messages = await messageLoaders[lang]();
        } catch {
          if (requestId !== loadRequestId) {
            return;
          }

          const fallback = get();
          applyMessages(fallback.loadedLang, fallback.messages);
          set({ lang: fallback.loadedLang, isLoaded: true });
          return;
        }

        if (requestId !== loadRequestId) {
          return;
        }

        applyMessages(lang, messages);
        set({ lang, messages, loadedLang: lang, isLoaded: true });
      },

      setLang: async (lang) => {
        await get().loadMessages(lang);
      },
    }),
    {
      name: getStorageKey("i18n"),
      version: 0,
      partialize: (state) => ({ lang: state.lang }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          void state.loadMessages(state.lang);
        }
      },
    },
  ),
);

const waitForHydration = async (): Promise<void> => {
  if (useI18nStore.persist.hasHydrated()) {
    return;
  }

  await new Promise<void>((resolve) => {
    const unsubscribe = useI18nStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });
};

export const initializeI18n = async (): Promise<void> => {
  await waitForHydration();
  await useI18nStore.getState().loadMessages(useI18nStore.getState().lang);
};
