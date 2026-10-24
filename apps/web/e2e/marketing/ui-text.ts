// Product copy the captures wait on, read from the app's own catalogs so a
// localized capture looks for the words its locale actually renders.
import { readFileSync } from "node:fs";

import { MARKETING_LOCALE_ACCOUNTS } from "@stll/playwright-tools/marketing-locales";
import type { MarketingLocale } from "@stll/playwright-tools/marketing-locales";

const catalogs = new Map<string, unknown>();

// Markets that share a language share its catalog.
const catalogFor = (locale: MarketingLocale): unknown => {
  const { language } = MARKETING_LOCALE_ACCOUNTS[locale];
  const cached = catalogs.get(language);
  if (cached !== undefined) {
    return cached;
  }
  const catalog: unknown = JSON.parse(
    readFileSync(
      new URL(`../../src/i18n/langs/${language}.json`, import.meta.url),
      "utf-8",
    ),
  );
  catalogs.set(language, catalog);
  return catalog;
};

/** The message at a dotted key, e.g. `uiText("cs", "billing.total")`. */
export const uiText = (locale: MarketingLocale, key: string): string => {
  let node = catalogFor(locale);
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) {
      throw new Error(`The ${locale} catalog has no message ${key}`);
    }
    node = Object.getOwnPropertyDescriptor(node, part)?.value;
  }
  if (typeof node !== "string") {
    throw new TypeError(`The ${locale} message ${key} is not a plain string`);
  }
  return node;
};
