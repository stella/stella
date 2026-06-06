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
  "pt-BR",
  "sk",
] as const;

export type SupportedLanguage = (typeof supportedLanguages)[number];
export type LocaleMessages = LocalizedMessages<Messages>;
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
  "pt-BR": async () => (await import("@/i18n/langs/pt-BR.json")).default,
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
  "pt-BR": "Português (Brasil)",
  sk: "Slovenčina",
} as const satisfies Record<SupportedLanguage, string>;

export const isSupportedLanguage = (
  value: string,
): value is SupportedLanguage => supportedLanguageSet.has(value);

const normalizeLocale = (value: string): string => value.replace("_", "-");

export const resolveSupportedLanguage = (
  value: string,
): SupportedLanguage | null => {
  const normalized = normalizeLocale(value);
  if (isSupportedLanguage(normalized)) {
    return normalized;
  }

  const prefix = normalized.split("-").at(0);
  if (!prefix) {
    return null;
  }

  if (isSupportedLanguage(prefix)) {
    return prefix;
  }

  if (prefix === "pt") {
    return "pt-BR";
  }

  return null;
};

const detectLang = (): SupportedLanguage => {
  const languages =
    typeof navigator !== "undefined" && "languages" in navigator
      ? navigator.languages
      : [];

  for (const candidate of languages) {
    const lang = resolveSupportedLanguage(candidate);
    if (lang) {
      return lang;
    }
  }

  return "en";
};

const defaultLanguage = detectLang();
const defaultMessages = en;

export const loadLocaleMessages = async (
  lang: SupportedLanguage,
): Promise<LocaleMessages> => await messageLoaders[lang]();

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
  // True once the first locale has loaded. Latches on and never resets, so a
  // later language switch (which flips isLoaded false while the new locale
  // streams in) cannot send the app back to the boot spinner and unmount it.
  hasLoadedOnce: boolean;
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
      // No locale has finished loading at construction, so the latch starts off
      // regardless of the browser default. loadMessages turns it on once a
      // bundle resolves (synchronously for English, after the async import
      // otherwise), which keeps the boot-spinner gate honest: a persisted
      // non-English locale cannot skip the spinner before its bundle arrives.
      hasLoadedOnce: false,

      loadMessages: async (lang) => {
        const state = get();
        if (state.loadedLang === lang && state.isLoaded) {
          set({ lang, hasLoadedOnce: true });
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
          set({
            lang: fallback.loadedLang,
            isLoaded: true,
            hasLoadedOnce: true,
          });
          return;
        }

        if (requestId !== loadRequestId) {
          return;
        }

        applyMessages(lang, messages);
        set({
          lang,
          messages,
          loadedLang: lang,
          isLoaded: true,
          hasLoadedOnce: true,
        });
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
