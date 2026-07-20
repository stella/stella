import { createFormatter, createTranslator } from "use-intl/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { getFolioMessages } from "@stll/folio-react/messages";
import { isUiLocale, resolveUiLocale } from "@stll/locales";
import type { UiLocale } from "@stll/locales";

import { getStorageKey } from "@/consts";
import en from "@/i18n/langs/en.json";
import type Messages from "@/i18n/langs/messages.gen";
import { resolveAppTimeZone, SERVER_I18N_TIME_ZONE } from "@/i18n/time-zone";
import { detached } from "@/lib/detached";
import { isPublicSsrPath } from "@/lib/public-ssr-paths";

type LocalizedMessages<T> = {
  [K in keyof T]: T[K] extends string ? string : LocalizedMessages<T[K]>;
};

// UI presentation order for language pickers. The membership is enforced
// against the shared `UiLocale` set (a stale entry fails typecheck); only the
// ordering is local. Message lookup itself is keyed, so order is cosmetic.
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
] as const satisfies readonly UiLocale[];

export type SupportedLanguage = UiLocale;
export type LocaleMessages = LocalizedMessages<Messages>;
type MessageLoader = () => LocaleMessages | Promise<LocaleMessages>;

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

export const isSupportedLanguage = isUiLocale;

export const resolveSupportedLanguage = resolveUiLocale;

const normalizeLocale = (value: string): string => value.replace("_", "-");

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

/**
 * Region subtag of the first browser locale that maps to a supported language
 * (e.g. "SA" from "ar-SA"). Drives region-specific formatting and, crucially,
 * the first day of the week (Saudi starts Sunday, the UAE Monday, generic
 * Arabic Saturday). Empty when the browser provides no region.
 */
const detectRegion = (): string => {
  const languages =
    typeof navigator !== "undefined" && "languages" in navigator
      ? navigator.languages
      : [];

  for (const candidate of languages) {
    const normalized = normalizeLocale(candidate);
    if (!resolveSupportedLanguage(normalized)) {
      continue;
    }
    try {
      const region = new Intl.Locale(normalized).region;
      if (region) {
        return region;
      }
    } catch {
      // Malformed tag; keep scanning.
    }
  }

  return "";
};

type MessageTree = { [key: string]: string | MessageTree };

const applyMessageDefaults = (
  target: MessageTree,
  defaults: MessageTree,
): void => {
  for (const [key, defaultValue] of Object.entries(defaults)) {
    // Guard the prototype chain: a literal `__proto__`/`constructor`/`prototype`
    // key in a catalog would otherwise pollute Object.prototype via assignment.
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const current = target[key];
    if (current === undefined) {
      target[key] = defaultValue;
      continue;
    }
    if (typeof current !== "string" && typeof defaultValue !== "string") {
      applyMessageDefaults(current, defaultValue);
    }
  }
};

/**
 * The folio editor ships its own UI catalog (`@stll/folio-react/messages`)
 * and reads the `folio.*` namespace from the app's IntlProvider. Merge the
 * package catalog under the app's own `folio.*` keys (the app wins on shared
 * keys, per the package's documented contract) so new editor strings resolve
 * at runtime without copying keys into the app language files.
 */
const withFolioMessages = (
  lang: SupportedLanguage,
  messages: LocaleMessages,
): LocaleMessages => {
  const folio = { ...messages.folio };
  applyMessageDefaults(folio, getFolioMessages(lang).folio);
  return { ...messages, folio };
};

const defaultLanguage = detectLang();
const defaultRegion = detectRegion();
const defaultMessages = withFolioMessages("en", en);

/**
 * The statically bundled English messages. Server-rendered public pages
 * render with these until hydration completes, so client markup can
 * match the server's regardless of the persisted locale.
 */
export const bundledEnglishMessages = defaultMessages;

export const loadLocaleMessages = async (
  lang: SupportedLanguage,
): Promise<LocaleMessages> =>
  withFolioMessages(lang, await messageLoaders[lang]());

let translator = createTranslator({
  locale: "en",
  messages: defaultMessages,
});

export const getTranslator = () => translator;

export type CalendarPreference = "auto" | "gregory" | "islamic-umalqura";
export type NumberingPreference = "auto" | "latn" | "arab";
export type RegionalFormatPreference = "auto" | "en-IN";
export type WeekStartPreference = "auto" | "saturday" | "sunday" | "monday";

export const REGIONAL_FORMATS = ["en-IN"] as const satisfies readonly Exclude<
  RegionalFormatPreference,
  "auto"
>[];

export const REGIONAL_FORMAT_LABELS = {
  "en-IN": "English (India)",
} as const satisfies Record<Exclude<RegionalFormatPreference, "auto">, string>;

const WEEK_START_KEYWORD = {
  saturday: "sat",
  sunday: "sun",
  monday: "mon",
} as const satisfies Record<Exclude<WeekStartPreference, "auto">, string>;

type FormattingLocaleOptions = {
  lang: SupportedLanguage;
  region: string;
  regionalFormat: RegionalFormatPreference;
  calendar: CalendarPreference;
  numberingSystem: NumberingPreference;
  weekStart: WeekStartPreference;
};

/**
 * BCP-47 locale used for formatting. The base carries the detected region
 * (e.g. ar-SA) so date/number formatting and the first day of the week follow
 * the country; Unicode (-u-) extensions carry the calendar, an explicit
 * first-day-of-week override (fw), and the number system. "auto" resolves to
 * Gregorian (the safe default for legal dates, even in Arabic) and to Eastern
 * Arabic-Indic digits for Arabic / Western digits elsewhere. A region-less,
 * all-default non-Arabic locale keeps its plain tag, so most callers are
 * unaffected.
 */
export const buildFormattingLocale = ({
  lang,
  region,
  regionalFormat,
  calendar,
  numberingSystem,
  weekStart,
}: FormattingLocaleOptions): string => {
  // A regional-format override is a complete locale because Intl grouping is
  // language-sensitive: en-IN uses lakhs/crores while de-IN does not. In auto
  // mode, skip the detected region when the UI language already encodes one
  // (e.g. pt-BR), which avoids an invalid tag like "pt-BR-BR".
  const autoBase = region && !lang.includes("-") ? `${lang}-${region}` : lang;
  const base = regionalFormat === "auto" ? autoBase : regionalFormat;
  const formattingLanguage = new Intl.Locale(base).language;
  const calendarSystem = calendar === "auto" ? "gregory" : calendar;
  const autoNumbers = formattingLanguage === "ar" ? "arab" : "latn";
  const numbers = numberingSystem === "auto" ? autoNumbers : numberingSystem;

  // Unicode extension keywords, kept in canonical (alphabetical) order: ca, fw, nu.
  const keywords: string[] = [];
  // Pin Arabic to an explicit calendar (some CLDR regions default to a
  // non-Gregorian one) and carry any non-Gregorian opt-in.
  if (calendarSystem !== "gregory" || formattingLanguage === "ar") {
    keywords.push(`ca-${calendarSystem}`);
  }
  if (weekStart !== "auto") {
    keywords.push(`fw-${WEEK_START_KEYWORD[weekStart]}`);
  }
  if (numbers !== "latn") {
    keywords.push(`nu-${numbers}`);
  }
  return keywords.length > 0 ? `${base}-u-${keywords.join("-")}` : base;
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
  // Detected browser region subtag (e.g. "SA"); not persisted — re-detected
  // each boot. Drives region-specific formatting and the first day of week.
  region: string;
  regionalFormat: RegionalFormatPreference;
  calendar: CalendarPreference;
  numberingSystem: NumberingPreference;
  weekStart: WeekStartPreference;
};

type Actions = {
  setLang: (lang: SupportedLanguage) => Promise<void>;
  loadMessages: (lang: SupportedLanguage) => Promise<void>;
  setCalendar: (calendar: CalendarPreference) => void;
  setNumberingSystem: (numberingSystem: NumberingPreference) => void;
  setRegionalFormat: (regionalFormat: RegionalFormatPreference) => void;
  setWeekStart: (weekStart: WeekStartPreference) => void;
};

let loadRequestId = 0;

const setDocumentLanguage = (lang: SupportedLanguage): void => {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.lang = lang;
  document.documentElement.dir = getLangDir(lang);
};

const refreshFormatter = (formattingLocale: string): void => {
  formatter = createFormatter({
    locale: formattingLocale,
    timeZone: resolveAppTimeZone(),
  });
};

type ApplyMessagesArgs = {
  lang: SupportedLanguage;
  messages: LocaleMessages;
  region: string;
  regionalFormat: RegionalFormatPreference;
  calendar: CalendarPreference;
  numberingSystem: NumberingPreference;
  weekStart: WeekStartPreference;
};

const applyMessages = ({
  lang,
  messages,
  region,
  regionalFormat,
  calendar,
  numberingSystem,
  weekStart,
}: ApplyMessagesArgs): void => {
  translator = createTranslator({
    locale: lang,
    messages,
  });
  refreshFormatter(
    buildFormattingLocale({
      lang,
      region,
      regionalFormat,
      calendar,
      numberingSystem,
      weekStart,
    }),
  );
  setDocumentLanguage(lang);
};

/** Rebuild the non-React formatter from the current store state. */
const recomputeFormatterForState = (state: State): void => {
  refreshFormatter(
    buildFormattingLocale({
      lang: state.loadedLang,
      region: state.region,
      regionalFormat: state.regionalFormat,
      calendar: state.calendar,
      numberingSystem: state.numberingSystem,
      weekStart: state.weekStart,
    }),
  );
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
      region: defaultRegion,
      regionalFormat: "auto",
      calendar: "auto",
      numberingSystem: "auto",
      weekStart: "auto",

      loadMessages: async (lang) => {
        const state = get();
        if (state.loadedLang === lang && state.isLoaded) {
          set({ lang, hasLoadedOnce: true });
          setDocumentLanguage(lang);
          // The bundle is already loaded (e.g. English on boot), but rehydrated
          // formatting prefs still need to reach the shared formatter, which
          // was initialized as plain English/UTC.
          recomputeFormatterForState(get());
          return;
        }

        const requestId = (loadRequestId += 1);
        set({ lang, isLoaded: false });

        let messages: LocaleMessages;
        try {
          messages = await loadLocaleMessages(lang);
        } catch {
          if (requestId !== loadRequestId) {
            return;
          }

          const fallback = get();
          applyMessages({
            lang: fallback.loadedLang,
            messages: fallback.messages,
            region: fallback.region,
            regionalFormat: fallback.regionalFormat,
            calendar: fallback.calendar,
            numberingSystem: fallback.numberingSystem,
            weekStart: fallback.weekStart,
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

        const { region, regionalFormat, calendar, numberingSystem, weekStart } =
          get();
        applyMessages({
          lang,
          messages,
          region,
          regionalFormat,
          calendar,
          numberingSystem,
          weekStart,
        });
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
        recomputeFormatterForState(get());
      },

      setNumberingSystem: (numberingSystem) => {
        set({ numberingSystem });
        recomputeFormatterForState(get());
      },

      setRegionalFormat: (regionalFormat) => {
        set({ regionalFormat });
        recomputeFormatterForState(get());
      },

      setWeekStart: (weekStart) => {
        set({ weekStart });
        recomputeFormatterForState(get());
      },
    }),
    {
      name: getStorageKey("i18n"),
      version: 0,
      partialize: (state) => ({
        lang: state.lang,
        calendar: state.calendar,
        numberingSystem: state.numberingSystem,
        regionalFormat: state.regionalFormat,
        weekStart: state.weekStart,
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
        detached(state.loadMessages(state.lang), "onRehydrateStorage");
      },
    },
  ),
);

/**
 * The current formatting locale for non-React code (region plus calendar,
 * number-system, and first-day-of-week extensions). React reads the same value
 * through use-intl's useLocale().
 */
export const getFormattingLocale = (): string => {
  const state = useI18nStore.getState();
  return buildFormattingLocale({
    lang: state.loadedLang,
    region: state.region,
    regionalFormat: state.regionalFormat,
    calendar: state.calendar,
    numberingSystem: state.numberingSystem,
    weekStart: state.weekStart,
  });
};

/** The message language, without regional formatting overrides. */
export const getMessageLocale = (): SupportedLanguage =>
  useI18nStore.getState().loadedLang;

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
