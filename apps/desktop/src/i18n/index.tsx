import { emit } from "@tauri-apps/api/event";
import { IntlProvider } from "use-intl";

import {
  getUiLocaleDirection,
  isUiLocale,
  resolveUiLocale,
} from "@stll/locales";
import type { UiLocale } from "@stll/locales";

import en from "./langs/en.json";

/** The desktop ships the same UI locales as the web app; `@stll/locales` is
 *  the only list, so neither side can gain or lose a language alone. */
export type SupportedLanguage = UiLocale;

// Presentation order for the language picker: English first, then by locale
// tag. Membership is checked against the shared set below, so only the order
// is local; message lookup is keyed, so the order is cosmetic.
export const SUPPORTED_LANGUAGES = [
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
] as const satisfies readonly SupportedLanguage[];

type MissingSupportedLanguage = Exclude<
  SupportedLanguage,
  (typeof SUPPORTED_LANGUAGES)[number]
>;

true satisfies MissingSupportedLanguage extends never ? true : never;

export const DESKTOP_LANGUAGE_CHANGED_EVENT = "desktop-language-changed";
const DESKTOP_LANGUAGE_STORAGE_KEY = "stella-desktop-language";

export const isSupportedLanguage = isUiLocale;

const detectLanguage = (): SupportedLanguage => {
  const languages =
    typeof navigator !== "undefined" && "languages" in navigator
      ? navigator.languages
      : [];

  for (const candidate of languages) {
    const language = resolveUiLocale(candidate);
    if (language) {
      return language;
    }
  }

  return "en";
};

export type DesktopMessages = typeof en;

// English is bundled with the app; every other catalogue is its own chunk,
// fetched when that language is chosen.
type CatalogueModule = { default: DesktopMessages };

const catalogueModules = {
  ar: async () => import("./langs/ar.json"),
  cs: async () => import("./langs/cs.json"),
  de: async () => import("./langs/de.json"),
  es: async () => import("./langs/es.json"),
  et: async () => import("./langs/et.json"),
  fr: async () => import("./langs/fr.json"),
  hu: async () => import("./langs/hu.json"),
  lt: async () => import("./langs/lt.json"),
  lv: async () => import("./langs/lv.json"),
  pl: async () => import("./langs/pl.json"),
  "pt-BR": async () => import("./langs/pt-BR.json"),
  sk: async () => import("./langs/sk.json"),
} as const satisfies Record<
  Exclude<SupportedLanguage, "en">,
  () => Promise<CatalogueModule>
>;

export const detectedLanguage = detectLanguage();

export const getPreferredLanguage = (): SupportedLanguage => {
  try {
    const storedLanguage = localStorage.getItem(DESKTOP_LANGUAGE_STORAGE_KEY);
    if (storedLanguage && isSupportedLanguage(storedLanguage)) {
      return storedLanguage;
    }
  } catch {
    return detectedLanguage;
  }

  return detectedLanguage;
};

export const setPreferredLanguage = async (language: SupportedLanguage) => {
  localStorage.setItem(DESKTOP_LANGUAGE_STORAGE_KEY, language);
  await emit(DESKTOP_LANGUAGE_CHANGED_EVENT, { language });
};

/** Lays the window out in the language's own direction, so an RTL locale
 *  mirrors the whole UI rather than only its text. */
export const applyDocumentLanguage = (language: SupportedLanguage): void => {
  document.documentElement.lang = language;
  document.documentElement.dir = getUiLocaleDirection(language);
};

const resolvedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export const loadMessages = async (
  language: SupportedLanguage,
): Promise<DesktopMessages> => {
  if (language === "en") {
    return en;
  }
  try {
    return (await catalogueModules[language]()).default;
  } catch {
    return en;
  }
};

export const defaultMessages = en;

export const DesktopIntlProvider = ({
  children,
  language,
  messages,
}: {
  children: React.ReactNode;
  language: SupportedLanguage;
  messages: DesktopMessages;
}) => (
  <IntlProvider
    locale={language}
    messages={messages}
    timeZone={resolvedTimeZone}
  >
    {children}
  </IntlProvider>
);
