import type { PropsWithChildren } from "react";
import { useEffect, useState } from "react";

import { IntlProvider } from "use-intl";
import { createTranslator } from "use-intl/core";

import {
  en,
  type LocaleMessages,
  messageLoaders,
  type SupportedLanguage,
  supportedLanguages,
} from "@stll/i18n";

const supportedSet: ReadonlySet<string> = new Set(supportedLanguages);

const isSupportedLanguage = (value: string): value is SupportedLanguage =>
  supportedSet.has(value);

const resolveSupportedLanguage = (
  candidate: string,
): SupportedLanguage | null => {
  const normalized = candidate.replace("_", "-");
  if (isSupportedLanguage(normalized)) {
    return normalized;
  }

  const prefix = normalized.split("-").at(0);
  if (prefix && isSupportedLanguage(prefix)) {
    return prefix;
  }

  if (prefix === "pt") {
    return "pt-BR";
  }

  return null;
};

// Outlook's own UI language is the strongest signal for an add-in; fall
// back to the browser locales when the host does not expose it.
const readOfficeDisplayLanguage = (): string | null => {
  const office: unknown = Reflect.get(globalThis, "Office");
  if (typeof office !== "object" || office === null || !("context" in office)) {
    return null;
  }
  const { context } = office;
  if (
    typeof context !== "object" ||
    context === null ||
    !("displayLanguage" in context)
  ) {
    return null;
  }
  return typeof context.displayLanguage === "string"
    ? context.displayLanguage
    : null;
};

const detectLanguage = (): SupportedLanguage => {
  const candidates: string[] = [];
  const officeLanguage = readOfficeDisplayLanguage();
  if (officeLanguage) {
    candidates.push(officeLanguage);
  }
  if (typeof navigator !== "undefined" && "languages" in navigator) {
    candidates.push(...navigator.languages);
  }

  for (const candidate of candidates) {
    const language = resolveSupportedLanguage(candidate);
    if (language) {
      return language;
    }
  }

  return "en";
};

const detectedLanguage = detectLanguage();

// Non-React surfaces (e.g. command handlers) translate through this
// instance. It stays on the bundled English catalog; only the task
// pane swaps in the detected locale's messages once they load.
export const translator = createTranslator({
  locale: detectedLanguage,
  messages: en,
});

export const OutlookIntlProvider = ({ children }: PropsWithChildren) => {
  const [messages, setMessages] = useState<LocaleMessages>(en);

  useEffect(() => {
    if (detectedLanguage === "en") {
      return;
    }

    void (async () => {
      const loaded = await messageLoaders[detectedLanguage]();
      setMessages(loaded);
    })();
  }, []);

  return (
    <IntlProvider
      locale={detectedLanguage}
      messages={messages}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      {children}
    </IntlProvider>
  );
};
