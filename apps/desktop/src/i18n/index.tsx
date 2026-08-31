import { emit } from "@tauri-apps/api/event";
import { IntlProvider } from "use-intl";

import en from "./langs/en.json";

export const SUPPORTED_LANGUAGES = [
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

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_LABELS = {
  cs: "Čeština",
  de: "Deutsch",
  en: "English",
  es: "Español",
  et: "Eesti",
  fr: "Français",
  hu: "Magyar",
  lt: "Lietuvių",
  lv: "Latviešu",
  pl: "Polski",
  sk: "Slovenčina",
} as const satisfies Record<SupportedLanguage, string>;

export const DESKTOP_LANGUAGE_CHANGED_EVENT = "desktop-language-changed";
const DESKTOP_LANGUAGE_STORAGE_KEY = "stella-desktop-language";

const supportedSet: ReadonlySet<string> = new Set(SUPPORTED_LANGUAGES);

export const isSupportedLanguage = (
  value: string,
): value is SupportedLanguage => supportedSet.has(value);

const detectLanguage = (): SupportedLanguage => {
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

const messageLoaders: Record<
  SupportedLanguage,
  () => typeof en | Promise<typeof en>
> = {
  en: () => en,
  cs: async () => (await import("./langs/cs.json")).default,
  de: async () => (await import("./langs/de.json")).default,
  es: async () => (await import("./langs/es.json")).default,
  et: async () => (await import("./langs/et.json")).default,
  fr: async () => (await import("./langs/fr.json")).default,
  hu: async () => (await import("./langs/hu.json")).default,
  lt: async () => (await import("./langs/lt.json")).default,
  lv: async () => (await import("./langs/lv.json")).default,
  pl: async () => (await import("./langs/pl.json")).default,
  sk: async () => (await import("./langs/sk.json")).default,
};

export type DesktopMessages = typeof en;

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

const resolvedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export const loadMessages = async (
  language: SupportedLanguage,
): Promise<DesktopMessages> => {
  try {
    return await messageLoaders[language]();
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
