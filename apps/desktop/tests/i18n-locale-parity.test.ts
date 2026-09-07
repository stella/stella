import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { UI_LOCALES } from "@stll/locales";

// The desktop ships exactly the locales the web app ships, with the same keys
// in every catalogue. Reading the directory (rather than a list repeated here)
// is what makes a forgotten file or a stray one fail.
const LANGS_DIR = join(import.meta.dir, "../src/i18n/langs");

const shippedLocales = readdirSync(LANGS_DIR)
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length));

type MessageTree = { readonly [key: string]: string | MessageTree };

const isMessageTree = (value: unknown): value is MessageTree =>
  typeof value === "object" && value !== null;

const flatten = (
  value: unknown,
  prefix: string,
  out: Record<string, string>,
): void => {
  if (typeof value === "string") {
    out[prefix] = value;
    return;
  }
  if (!isMessageTree(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, out);
  }
};

/** Message paths mapped to their text, e.g. `tray.settings`. */
const readCatalogue = (locale: string): Record<string, string> => {
  const parsed: unknown = JSON.parse(
    readFileSync(join(LANGS_DIR, `${locale}.json`), "utf-8"),
  );
  const messages: Record<string, string> = {};
  flatten(parsed, "", messages);
  return messages;
};

// A `{name}` argument the source carries must survive translation. The pattern
// skips `{count, plural, …}` (a comma follows that name), so only real
// placeholders are compared. Which arguments appear is what has to match, not
// how often: a locale with more plural branches repeats `{count}` more times.
const PLACEHOLDER_PATTERN = /\{([A-Za-z]\w*)\}/gu;

const placeholders = (message: string): string[] => [
  ...new Set(
    [...message.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1] ?? ""),
  ),
];

const english = readCatalogue("en");
const translatedLocales = UI_LOCALES.filter((locale) => locale !== "en");

describe("desktop locale catalogues", () => {
  test("ship exactly the UI locales the web app ships", () => {
    expect(shippedLocales.toSorted()).toEqual([...UI_LOCALES].toSorted());
  });

  for (const locale of translatedLocales) {
    test(`${locale} has every English key and no extras`, () => {
      expect(Object.keys(readCatalogue(locale)).toSorted()).toEqual(
        Object.keys(english).toSorted(),
      );
    });

    test(`${locale} keeps the placeholders of the English source`, () => {
      const catalogue = readCatalogue(locale);
      for (const [key, source] of Object.entries(english)) {
        expect([key, placeholders(catalogue[key] ?? "").toSorted()]).toEqual([
          key,
          placeholders(source).toSorted(),
        ]);
      }
    });
  }
});
