import { createContext, createElement, use } from "react";
import type { PropsWithChildren } from "react";

import { createIsomorphicFn } from "@tanstack/react-start";
import { createFormatter, createTranslator } from "use-intl/core";
import { create, useStore } from "zustand";

import folioEn from "@stll/folio-react/messages/en";
import type { FolioLocale } from "@stll/folio-react/messages/locales";
import { getUiLocaleDirection } from "@stll/locales";
import type { UiLocale } from "@stll/locales";

import en from "@/i18n/langs/en.json";
import {
  getRequestI18nStore,
  initializeRequestI18n,
} from "@/i18n/request-i18n.server";
import { resolveAppTimeZone, SERVER_I18N_TIME_ZONE } from "@/i18n/time-zone";
import {
  getTranslator as getBrowserTranslator,
  setTranslator,
} from "@/i18n/translator";
import { defaultPresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import type { PresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import { persistPresentationPrefs } from "@/lib/account/presentation-prefs/provider";
import { getAnalytics } from "@/lib/analytics/provider";
import { notifyUserError } from "@/lib/errors/user-toast";

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

type MissingSupportedLanguage = Exclude<
  UiLocale,
  (typeof supportedLanguages)[number]
>;

true satisfies MissingSupportedLanguage extends never ? true : never;

export type SupportedLanguage = UiLocale;
export type LocaleMessages = typeof en;
type MessageLoader = () => LocaleMessages | Promise<LocaleMessages>;

export const messageLoaders = {
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

// Every app language needs a folio editor catalog; a language folio does not
// ship fails typecheck here instead of rendering English editor strings.
type MissingFolioLocale = Exclude<SupportedLanguage, FolioLocale>;

true satisfies MissingFolioLocale extends never ? true : never;

type FolioCatalog = typeof folioEn;
type FolioCatalogLoader = () => FolioCatalog | Promise<FolioCatalog>;

// One module per locale keeps the other catalogs out of the eager graph; the
// all-locales entry is banned in apps/web by oxlint.config.ts.
export const folioMessageLoaders = {
  en: () => folioEn,
  ar: async () => (await import("@stll/folio-react/messages/ar")).default,
  cs: async () => (await import("@stll/folio-react/messages/cs")).default,
  de: async () => (await import("@stll/folio-react/messages/de")).default,
  es: async () => (await import("@stll/folio-react/messages/es")).default,
  et: async () => (await import("@stll/folio-react/messages/et")).default,
  fr: async () => (await import("@stll/folio-react/messages/fr")).default,
  hu: async () => (await import("@stll/folio-react/messages/hu")).default,
  lt: async () => (await import("@stll/folio-react/messages/lt")).default,
  lv: async () => (await import("@stll/folio-react/messages/lv")).default,
  pl: async () => (await import("@stll/folio-react/messages/pl")).default,
  "pt-BR": async () =>
    (await import("@stll/folio-react/messages/pt-BR")).default,
  sk: async () => (await import("@stll/folio-react/messages/sk")).default,
} as const satisfies Record<SupportedLanguage, FolioCatalogLoader>;

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

export const getLangDir = getUiLocaleDirection;

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
 * The folio editor ships its own UI catalog (`@stll/folio-react/messages/*`)
 * and reads the `folio.*` namespace from the app's IntlProvider. Merge the
 * package catalog under the app's own `folio.*` keys (the app wins on shared
 * keys, per the package's documented contract) so new editor strings resolve
 * at runtime without copying keys into the app language files.
 */
const withFolioMessages = (
  messages: LocaleMessages,
  folioCatalog: FolioCatalog,
): LocaleMessages => {
  const folio = { ...messages.folio };
  applyMessageDefaults(folio, folioCatalog.folio);
  return { ...messages, folio };
};

const defaultLanguage = "en";
const defaultRegion = defaultPresentationPrefs.region;
const defaultMessages = withFolioMessages(en, folioEn);

/**
 * The statically bundled English messages. Server-rendered public pages
 * render with these until hydration completes, so client markup can
 * match the server's regardless of the persisted locale.
 */
export const bundledEnglishMessages = defaultMessages;

// Both catalogs load in parallel and are merged before the store applies them,
// so a language switch never renders English editor strings in between.
export const loadLocaleMessages = async (
  lang: SupportedLanguage,
): Promise<LocaleMessages> => {
  const [messages, folioCatalog] = await Promise.all([
    messageLoaders[lang](),
    folioMessageLoaders[lang](),
  ]);
  return withFolioMessages(messages, folioCatalog);
};

setTranslator(
  createTranslator({
    locale: "en",
    messages: defaultMessages,
  }),
);

export const getTranslator = createIsomorphicFn()
  .server(() => {
    const state = currentI18nStore().getState();
    const cached = requestTranslators.get(state);
    if (cached) {
      return cached;
    }
    const translator = createTranslator({
      locale: state.loadedLang,
      messages: state.messages,
    });
    requestTranslators.set(state, translator);
    return translator;
  })
  .client(() => getBrowserTranslator());

type CalendarPreference = PresentationPrefs["calendar"];
type NumberingPreference = PresentationPrefs["numberingSystem"];
export type RegionalFormatPreference = PresentationPrefs["regionalFormat"];
type WeekStartPreference = PresentationPrefs["weekStart"];

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
  if (numbers !== "latn" || formattingLanguage === "ar") {
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
let formatterLocale = "en";
let formatterTimeZone = SERVER_I18N_TIME_ZONE;

export const getFormatter = createIsomorphicFn()
  .server(() =>
    createFormatter({
      locale: getFormattingLocale(),
      timeZone: SERVER_I18N_TIME_ZONE,
    }),
  )
  .client(() => formatter);

type State = {
  lang: SupportedLanguage;
  messages: LocaleMessages;
  loadedLang: SupportedLanguage;
  isLoaded: boolean;
  // True once the first locale has loaded. Latches on and never resets, so a
  // later language switch (which flips isLoaded false while the new locale
  // streams in) cannot send the app back to the boot spinner and unmount it.
  hasLoadedOnce: boolean;
  // Server-readable region subtag for regional formatting and the first day of week.
  region: string;
  regionalFormat: RegionalFormatPreference;
  calendar: CalendarPreference;
  numberingSystem: NumberingPreference;
  weekStart: WeekStartPreference;
};

type Actions = {
  loadMessages: (
    lang: SupportedLanguage,
    isCurrent?: () => boolean,
  ) => Promise<void>;
  setCalendar: (calendar: CalendarPreference) => void;
  setNumberingSystem: (numberingSystem: NumberingPreference) => void;
  setRegionalFormat: (regionalFormat: RegionalFormatPreference) => void;
  setWeekStart: (weekStart: WeekStartPreference) => void;
};

let loadRequestId = 0;

const refreshFormatter = (
  formattingLocale: string,
  timeZone = resolveAppTimeZone(),
): void => {
  formatterLocale = formattingLocale;
  formatterTimeZone = timeZone;
  formatter = createFormatter({
    locale: formattingLocale,
    timeZone,
  });
};

export const synchronizeFormatterTimeZone = (timeZone: string): void => {
  if (formatterTimeZone === timeZone) {
    return;
  }
  refreshFormatter(formatterLocale, timeZone);
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
  setTranslator(
    createTranslator({
      locale: lang,
      messages,
    }),
  );
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

export type I18nState = State & Actions;

const browserI18nStore = create<I18nState>()((set, get) => ({
  lang: defaultLanguage,
  messages: defaultMessages,
  loadedLang: "en",
  isLoaded: true,
  // Router hydration supplies the request catalogue before the first render.
  // The default store stays unready until that snapshot exists.
  hasLoadedOnce: false,
  region: defaultRegion,
  regionalFormat: "auto",
  calendar: "auto",
  numberingSystem: "auto",
  weekStart: "auto",

  loadMessages: async (lang, isCurrent = () => true) => {
    if (!isCurrent()) {
      return;
    }
    const state = get();
    if (state.loadedLang === lang && state.isLoaded) {
      set({ lang, hasLoadedOnce: true });
      // The bundle is already loaded (e.g. English on boot), but rehydrated
      // formatting prefs still need to reach the shared formatter, which
      // was initialized as plain English/UTC.
      recomputeFormatterForState(get());
      return;
    }

    loadRequestId += 1;
    const requestId = loadRequestId;
    set({ lang, isLoaded: false });

    let messages: LocaleMessages;
    try {
      messages = await loadLocaleMessages(lang);
    } catch (error) {
      if (requestId !== loadRequestId || !isCurrent()) {
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
      // The UI stays in the previous language; tell the user the switch
      // did not happen. The toast renders in that previous language.
      getAnalytics().captureError(error, {
        fingerprintKey: "loadMessages:failure",
        scope: { type: "handler", handlerId: "loadMessages:failure" },
      });
      notifyUserError(error, getTranslator()("common.languageLoadFailed"));
      return;
    }

    if (requestId !== loadRequestId || !isCurrent()) {
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

  setCalendar: (calendar) => {
    set({ calendar });
    persistPresentationPrefs(() => ({ calendar }));
    recomputeFormatterForState(get());
  },

  setNumberingSystem: (numberingSystem) => {
    set({ numberingSystem });
    persistPresentationPrefs(() => ({ numberingSystem }));
    recomputeFormatterForState(get());
  },

  setRegionalFormat: (regionalFormat) => {
    set({ regionalFormat });
    persistPresentationPrefs(() => ({ regionalFormat }));
    recomputeFormatterForState(get());
  },

  setWeekStart: (weekStart) => {
    set({ weekStart });
    persistPresentationPrefs(() => ({ weekStart }));
    recomputeFormatterForState(get());
  },
}));

const requestTranslators = new WeakMap([
  [browserI18nStore.getInitialState(), getBrowserTranslator()],
]);

let clientInitialState = browserI18nStore.getInitialState();
const browserHydrationStore = {
  getState: browserI18nStore.getState,
  setState: browserI18nStore.setState,
  subscribe: browserI18nStore.subscribe,
  getInitialState: () => clientInitialState,
};

const currentI18nStore = createIsomorphicFn()
  .server(() => getRequestI18nStore() ?? browserI18nStore)
  .client(() => browserHydrationStore);

const RenderedI18nStoreContext = createContext<
  ReturnType<typeof currentI18nStore> | undefined
>(undefined);

/** Bind the initialized request store to streamed React descendants. */
export const RenderedI18nStoreProvider = ({ children }: PropsWithChildren) =>
  createElement(
    RenderedI18nStoreContext,
    { value: currentI18nStore() },
    children,
  );

export const useI18nStore = Object.assign(
  <T>(selector: (state: I18nState) => T): T => {
    const renderedStore = use(RenderedI18nStoreContext);
    return useStore(renderedStore ?? currentI18nStore(), selector);
  },
  {
    getState: () => currentI18nStore().getState(),
    setState: browserI18nStore.setState,
    subscribe: browserI18nStore.subscribe,
  },
);

type FormattingPreferences = Pick<
  PresentationPrefs,
  "calendar" | "numberingSystem" | "region" | "regionalFormat" | "weekStart"
>;

/** Apply committed presentation preferences without persisting them again. */
export const synchronizeFormattingPreferences = (
  preferences: FormattingPreferences,
): void => {
  const state = browserI18nStore.getState();
  if (
    state.calendar === preferences.calendar &&
    state.numberingSystem === preferences.numberingSystem &&
    state.region === preferences.region &&
    state.regionalFormat === preferences.regionalFormat &&
    state.weekStart === preferences.weekStart
  ) {
    return;
  }
  browserI18nStore.setState(preferences);
  recomputeFormatterForState(browserI18nStore.getState());
};

type RenderedLocaleOptions = {
  locale: SupportedLanguage;
  messages: LocaleMessages;
  prefs: PresentationPrefs;
};
const renderedLocaleState = ({
  locale,
  messages,
  prefs,
}: RenderedLocaleOptions): I18nState => ({
  ...browserI18nStore.getInitialState(),
  lang: locale,
  loadedLang: locale,
  messages,
  hasLoadedOnce: true,
  isLoaded: true,
  region: prefs.region,
  regionalFormat: prefs.regionalFormat,
  calendar: prefs.calendar,
  numberingSystem: prefs.numberingSystem,
  weekStart: prefs.weekStart,
});
export const initializeRenderedLocale = createIsomorphicFn()
  .server((options: RenderedLocaleOptions) =>
    initializeRequestI18n(renderedLocaleState(options)),
  )
  .client((options: RenderedLocaleOptions) => {
    clientInitialState = renderedLocaleState(options);
    browserI18nStore.setState(clientInitialState);
    applyMessages(clientInitialState);
  });

/** Apply an account locale after hydration without replacing the SSR snapshot. */
export const applyClientDocumentLocale = (
  options: RenderedLocaleOptions,
): void => {
  const state = renderedLocaleState(options);
  browserI18nStore.setState(state);
  applyMessages(state);
};

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
