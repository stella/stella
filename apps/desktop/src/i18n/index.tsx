import { IntlProvider } from "use-intl";

import en from "./langs/en.json";

const SUPPORTED_LANGUAGES = [
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

type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const supportedSet: ReadonlySet<string> = new Set(SUPPORTED_LANGUAGES);

const isSupportedLanguage = (value: string): value is SupportedLanguage =>
  supportedSet.has(value);

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

export const loadMessages = async (): Promise<DesktopMessages> => {
  try {
    return await messageLoaders[detectedLanguage]();
  } catch {
    return en;
  }
};

export const defaultMessages = en;

export const DesktopIntlProvider = ({
  children,
  messages,
}: {
  children: React.ReactNode;
  messages: DesktopMessages;
}) => (
  <IntlProvider
    locale={detectedLanguage}
    messages={messages}
    timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
  >
    {children}
  </IntlProvider>
);
