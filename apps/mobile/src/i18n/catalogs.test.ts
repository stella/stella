import { describe, expect, test } from "bun:test";

import { UI_LOCALES } from "@stll/locales";
import {
  findIcuError,
  findPlaceholderMismatch,
} from "@stll/scripts/src/i18n-lint";

import { CATALOGS } from "./catalogs";

type Catalog = { readonly [key: string]: string | Catalog };

/** Every leaf of a catalogue as `path -> message`. */
const leaves = (catalog: Catalog, prefix = ""): Map<string, string> => {
  const found = new Map<string, string>();
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "string") {
      found.set(path, value);
    } else {
      for (const [leaf, message] of leaves(value, path)) {
        found.set(leaf, message);
      }
    }
  }
  return found;
};

const english = leaves(CATALOGS.en);

describe("mobile catalogues", () => {
  test("ship exactly the shared UI locales", () => {
    expect(Object.keys(CATALOGS).toSorted()).toEqual(
      [...UI_LOCALES].toSorted(),
    );
  });

  test.each(UI_LOCALES.filter((locale) => locale !== "en"))(
    "%s has exactly the English keys and placeholders, all translated",
    (locale) => {
      const translated = leaves(CATALOGS[locale]);
      expect([...translated.keys()].toSorted()).toEqual(
        [...english.keys()].toSorted(),
      );
      for (const [path, message] of translated) {
        const source = english.get(path) ?? "";
        // Parsed as ICU, so words inside plural branches are not arguments.
        expect({ path, error: findIcuError(message) }).toEqual({
          path,
          error: null,
        });
        expect({
          path,
          mismatch: findPlaceholderMismatch(source, message),
        }).toEqual({ path, mismatch: null });
        expect({ path, empty: message.trim() === "" }).toEqual({
          path,
          empty: false,
        });
      }
    },
  );
});
