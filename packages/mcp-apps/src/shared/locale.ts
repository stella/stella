import { panic } from "better-result";

import { normalizeLocale } from "@stll/agent-input";
import { getUiLocaleDirection, resolveUiLocale } from "@stll/locales";

import messages from "./generated/messages.json";

type BrowserLocale = {
  documentLanguage: string | undefined;
  navigatorLanguages: readonly string[];
};
type AppLocaleSource = "host" | "document" | "navigator" | "default";

const browserLocale = () => {
  const navigatorLanguages = (() => {
    if (typeof navigator === "undefined") {
      return [];
    }
    if (navigator.languages.length > 0) {
      return navigator.languages;
    }
    return [navigator.language];
  })();
  return {
    documentLanguage:
      typeof document === "undefined"
        ? undefined
        : document.documentElement.lang,
    navigatorLanguages,
  };
};

export const appLocale = (
  hostLocale: string | undefined,
  browser: BrowserLocale = browserLocale(),
) => {
  const candidates = [
    { source: "host", value: hostLocale },
    { source: "document", value: browser.documentLanguage },
    ...browser.navigatorLanguages.map(
      (value) => ({ source: "navigator", value }) as const,
    ),
    { source: "default", value: "en" },
  ] as const satisfies readonly {
    source: AppLocaleSource;
    value: string | undefined;
  }[];
  for (const { source, value } of candidates) {
    if (value === undefined || value === "") {
      continue;
    }
    const canonical = normalizeLocale(value);
    if (!canonical.ok) {
      continue;
    }
    const locale = resolveUiLocale(canonical.value);
    if (locale === null) {
      continue;
    }
    return {
      source,
      locale,
      // Preserve regional and Unicode numbering-system preferences for formatters.
      formattingLocale: canonical.value,
      direction: getUiLocaleDirection(locale),
      messages: messages[locale],
    };
  }
  return panic("MCP app source locale is unavailable");
};

export const setAppDocumentLocale = (
  hostLocale: string | undefined,
  title?: string,
) => {
  const resolved = appLocale(hostLocale);
  document.documentElement.lang = resolved.formattingLocale;
  document.documentElement.dir = resolved.direction;
  document.title = title ?? resolved.messages.title;
  return resolved;
};
