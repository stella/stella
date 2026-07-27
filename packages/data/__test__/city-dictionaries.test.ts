import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CITY_DICTIONARY_COUNTRIES,
  hasCityDictionary,
  loadCityDictionary,
} from "../dictionaries/index";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DICTIONARIES_DIR = join(__dirname, "..", "dictionaries");
const CITIES_DIR = join(DICTIONARIES_DIR, "cities");

describe("city dictionary loading", () => {
  test("covers every bundled cities/*.json", () => {
    const files = readdirSync(CITIES_DIR)
      .map((name) => name.replace(/\.json$/, ""))
      .sort();
    expect([...CITY_DICTIONARY_COUNTRIES].sort()).toEqual(files);
  });

  test("every covered country loads a non-empty dictionary", async () => {
    // The loader map is generated; a stale or misspelled entry
    // would resolve to nothing and silently under-redact.
    const entries = await Promise.all(
      CITY_DICTIONARY_COUNTRIES.map(async (country) => ({
        country,
        count: (await loadCityDictionary(country)).length,
      })),
    );
    const empty = entries.filter(({ count }) => count === 0);
    expect(empty).toEqual([]);
  });

  test.each([
    ["FR", "Paris"],
    ["CZ", "Praha"],
    ["CZ", "Prague"],
    ["US", "Chicago"],
    ["JP", "Kyoto"],
  ])("%s includes %s", async (country, city) => {
    expect(await loadCityDictionary(country)).toContain(city);
  });

  test("country codes are case insensitive", async () => {
    expect(await loadCityDictionary("fr")).toContain("Paris");
    expect(hasCityDictionary("fr")).toBe(true);
  });

  test("an uncovered country returns no cities", async () => {
    expect(hasCityDictionary("ZZ")).toBe(false);
    expect(await loadCityDictionary("ZZ")).toEqual([]);
    expect(await loadCityDictionary("not-a-country")).toEqual([]);
  });
});

describe("bundler-resolvable specifiers", () => {
  const sourceFiles = readdirSync(DICTIONARIES_DIR).filter((name) =>
    name.endsWith(".ts"),
  );

  // A computed import() specifier cannot be rewritten by a bundler:
  // it survives into the chunk verbatim, fails to resolve in every
  // bundled consumer, and turns a dictionary into zero entries.
  const COMPUTED_SPECIFIER_RE = /\bimport\(\s*`[^`]*\$\{/;

  test("dictionary sources exist", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  test.each(sourceFiles)("%s has no computed import specifier", (name) => {
    const source = readFileSync(join(DICTIONARIES_DIR, name), "utf-8");
    expect(COMPUTED_SPECIFIER_RE.test(source)).toBe(false);
  });
});
