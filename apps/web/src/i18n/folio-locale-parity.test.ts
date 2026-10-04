import { expect, test } from "bun:test";

import { FOLIO_LOCALES } from "@stll/folio-react/messages/locales";

import {
  folioMessageLoaders,
  loadLocaleMessages,
  supportedLanguages,
} from "@/i18n/i18n-store";

const FOLIO_LOCALE_SET: ReadonlySet<string> = new Set(FOLIO_LOCALES);

/** Key paths of `catalog` that do not resolve to a string in `merged`. */
const collectMissingPaths = (
  merged: unknown,
  catalog: unknown,
  path: string,
): string[] => {
  if (typeof catalog !== "object" || catalog === null) {
    return typeof merged === "string" ? [] : [path];
  }
  if (typeof merged !== "object" || merged === null) {
    return [path];
  }
  const mergedEntries = new Map(Object.entries(merged));
  return Object.entries(catalog).flatMap(([key, value]) =>
    collectMissingPaths(mergedEntries.get(key), value, `${path}.${key}`),
  );
};

test("folio ships an editor catalog for every app language", () => {
  expect(
    supportedLanguages.filter((lang) => !FOLIO_LOCALE_SET.has(lang)),
  ).toEqual([]);
  expect(Object.keys(folioMessageLoaders).toSorted()).toEqual(
    [...supportedLanguages].toSorted(),
  );
});

test.each(supportedLanguages)(
  "%s messages carry every key of its folio catalog",
  async (lang) => {
    const [folioCatalog, messages] = await Promise.all([
      folioMessageLoaders[lang](),
      loadLocaleMessages(lang),
    ]);

    expect(
      collectMissingPaths(messages.folio, folioCatalog.folio, "folio"),
    ).toEqual([]);
  },
);
