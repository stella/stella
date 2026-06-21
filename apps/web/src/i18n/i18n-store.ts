import { createFormatter, createTranslator } from "use-intl/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { getStorageKey } from "@/consts";
import en from "@/i18n/langs/en.json";
import type Messages from "@/i18n/langs/messages.gen";
import { resolveAppTimeZone, SERVER_I18N_TIME_ZONE } from "@/i18n/time-zone";
import { isPublicSsrPath } from "@/lib/public-ssr-paths";

type LocalizedMessages<T> = {
  [K in keyof T]: T[K] extends string ? string : LocalizedMessages<T[K]>;
};

export const supportedLanguages = [
  "en",
  "ar",
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
  ar: async () => (await import("@/i18n/langs/ar.json")).default,
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
  ar: "العربية",
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

export type TextDirection = "ltr" | "rtl";

// Per-locale base writing direction. The map is kept complete by `satisfies`,
// so adding a right-to-left language (e.g. Arabic) is a single new row here.
const LANG_DIR = {
  en: "ltr",
  ar: "rtl",
  cs: "ltr",
  de: "ltr",
  es: "ltr",
  et: "ltr",
  fr: "ltr",
  hu: "ltr",
  lt: "ltr",
  lv: "ltr",
  pl: "ltr",
  "pt-BR": "ltr",
  sk: "ltr",
} as const satisfies Record<SupportedLanguage, TextDirection>;

export const getLangDir = (lang: SupportedLanguage): TextDirection =>
  LANG_DIR[lang];

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

/**
 * The statically bundled English messages. Server-rendered public pages
 * render with these until hydration completes, so client markup can
 * match the server's regardless of the persisted locale.
 */
export const bundledEnglishMessages = en;

export const loadLocaleMessages = async (
  lang: SupportedLanguage,
): Promise<LocaleMessages> => await messageLoaders[lang]();

let translator = createTranslator({
  locale: "en",
  messages: defaultMessages,
});

export const getTranslator = () => translator;

export type CalendarPreference = "auto" | "gregory" | "islamic-umalqura";
export type NumberingPreference = "auto" | "latn" | "arab";

/**
 * BCP-47 locale used for formatting, carrying the user's calendar and
 * number-system preferences as Unicode (-u-) extensions. "auto" resolves to
 * Gregorian (the safe default for legal dates, even in Arabic) and to Eastern
 * Arabic-Indic digits for Arabic / Western digits elsewhere. Non-Arabic locales
 * on the default preferences keep their plain tag, so most callers are
 * unaffected.
 */
export const buildFormattingLocale = (
  lang: SupportedLanguage,
  calendar: CalendarPreference,
  numberingSystem: NumberingPreference,
): string => {
  const calendarSystem = calendar === "auto" ? "gregory" : calendar;
  const autoNumbers = lang === "ar" ? "arab" : "latn";
  const numbers = numberingSystem === "auto" ? autoNumbers : numberingSystem;

  const keywords: string[] = [];
  // Pin Arabic to an explicit calendar (some CLDR regions default to a
  // non-Gregorian one) and carry any non-Gregorian opt-in.
  if (calendarSystem !== "gregory" || lang === "ar") {
    keywords.push(`ca-${calendarSystem}`);
  }
  if (numbers !== "latn") {
    keywords.push(`nu-${numbers}`);
  }
  return keywords.length > 0 ? `${lang}-u-${keywords.join("-")}` : lang;
};

// Locale-aware formatter for non-React code (utilities, store logic), mirroring
// getTranslator. React components should use use-intl's useFormatter, which
// reads the same locale from the provider. Both are kept in sync by the store.
let formatter = createFormatter({
  locale: "en",
  timeZone: SERVER_I18N_TIME_ZONE,
});

export const getFormatter = () => formatter;

type State = {
  lang: SupportedLanguage;
  messages: LocaleMessages;
  loadedLang: SupportedLanguage;
  isLoaded: boolean;
  // True once the first locale has loaded. Latches on and never resets, so a
  // later language switch (which flips isLoaded false while the new locale
  // streams in) cannot send the app back to the boot spinner and unmount it.
  hasLoadedOnce: boolean;
  calendar: CalendarPreference;
  numberingSystem: NumberingPreference;
};

type Actions = {
  setLang: (lang: SupportedLanguage) => Promise<void>;
  loadMessages: (lang: SupportedLanguage) => Promise<void>;
  setCalendar: (calendar: CalendarPreference) => void;
  setNumberingSystem: (numberingSystem: NumberingPreference) => void;
};

let loadRequestId = 0;

const setDocumentLanguage = (lang: SupportedLanguage): void => {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.lang = lang;
  document.documentElement.dir = getLangDir(lang);
};

const refreshFormatter = (
  lang: SupportedLanguage,
  calendar: CalendarPreference,
  numberingSystem: NumberingPreference,
): void => {
  formatter = createFormatter({
    locale: buildFormattingLocale(lang, calendar, numberingSystem),
    timeZone: resolveAppTimeZone(),
  });
};

type ApplyMessagesArgs = {
  lang: SupportedLanguage;
  messages: LocaleMessages;
  calendar: CalendarPreference;
  numberingSystem: NumberingPreference;
};

const applyMessages = ({
  lang,
  messages,
  calendar,
  numberingSystem,
}: ApplyMessagesArgs): void => {
  translator = createTranslator({
    locale: lang,
    messages,
  });
  refreshFormatter(lang, calendar, numberingSystem);
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
      calendar: "auto",
      numberingSystem: "auto",

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
          applyMessages({
            lang: fallback.loadedLang,
            messages: fallback.messages,
            calendar: fallback.calendar,
            numberingSystem: fallback.numberingSystem,
          });
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

        const { calendar, numberingSystem } = get();
        applyMessages({ lang, messages, calendar, numberingSystem });
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

      setCalendar: (calendar) => {
        set({ calendar });
        const { loadedLang, numberingSystem } = get();
        refreshFormatter(loadedLang, calendar, numberingSystem);
      },

      setNumberingSystem: (numberingSystem) => {
        set({ numberingSystem });
        const { calendar, loadedLang } = get();
        refreshFormatter(loadedLang, calendar, numberingSystem);
      },
    }),
    {
      name: getStorageKey("i18n"),
      version: 0,
      partialize: (state) => ({
        lang: state.lang,
        calendar: state.calendar,
        numberingSystem: state.numberingSystem,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) {
          return;
        }
        // Public SSR paths hydrate against server-rendered English; the
        // client entrypoint loads the persisted locale after first paint
        // instead of this eager rehydration hook.
        if (
          typeof window !== "undefined" &&
          isPublicSsrPath(window.location.pathname)
        ) {
          return;
        }
        void state.loadMessages(state.lang);
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
