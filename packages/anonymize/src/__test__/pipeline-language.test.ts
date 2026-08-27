import { describe, expect, test } from "bun:test";

import languageScopes from "../data/language-scopes.json";
import { defaultDictionaryBundleOptions } from "../build-native-package";
import { applyPipelineLanguageScope } from "../language-scope";
import { DEFAULT_NATIVE_PIPELINE_CONFIG } from "../native-default-config";
import { loadDictionaryBundle } from "../../../data/dictionaries/cities";
import {
  normalizePipelineLanguageSelection,
  pipelineLanguageSelectionKey,
  SUPPORTED_LANGUAGES,
} from "../pipeline-language";

describe("pipeline language selection", () => {
  test("derives supported languages from the canonical scope data", () => {
    expect(SUPPORTED_LANGUAGES.join(",")).toBe(
      Object.keys(languageScopes.languages).toSorted().join(","),
    );
  });

  test("defaults to all languages", () => {
    expect(normalizePipelineLanguageSelection(undefined)).toEqual({
      type: "all",
    });
    expect(normalizePipelineLanguageSelection("all")).toEqual({ type: "all" });
    expect(
      Reflect.apply(normalizePipelineLanguageSelection, undefined, [" ALL "]),
    ).toEqual({ type: "all" });
  });

  test("normalizes, deduplicates, and sorts language selections", () => {
    const selection = normalizePipelineLanguageSelection(["en", "cs", "en"]);
    expect(selection).toEqual({
      type: "languages",
      languages: ["cs", "en"],
    });
    expect(pipelineLanguageSelectionKey(selection)).toBe("cs,en");
  });

  test("rejects empty and unsupported language selections", () => {
    expect(() =>
      Reflect.apply(normalizePipelineLanguageSelection, undefined, [[]]),
    ).toThrow("must not be empty");
    expect(() =>
      Reflect.apply(normalizePipelineLanguageSelection, undefined, ["nl"]),
    ).toThrow("Unsupported pipeline language");
    expect(() =>
      Reflect.apply(normalizePipelineLanguageSelection, undefined, [
        "toString",
      ]),
    ).toThrow("Unsupported pipeline language");
  });

  test("preserves a supported language's explicit empty name scope", () => {
    const scoped = applyPipelineLanguageScope({
      ...DEFAULT_NATIVE_PIPELINE_CONFIG,
      language: "lv",
    });

    expect(scoped.nameCorpusLanguages).toEqual([]);
    expect(scoped.denyListCountries).toEqual(["LV"]);
  });

  test("loads an exact Latvian dictionary scope through the published data API", async () => {
    const scoped = applyPipelineLanguageScope({
      ...DEFAULT_NATIVE_PIPELINE_CONFIG,
      language: "lv",
    });
    const dictionaries = await loadDictionaryBundle(
      defaultDictionaryBundleOptions(scoped),
    );

    expect(dictionaries.firstNames).toEqual({});
    expect(dictionaries.surnames).toEqual({});
    expect(Object.keys(dictionaries.citiesByCountry)).toEqual(["LV"]);
    expect(Object.values(dictionaries.denyListMeta)).not.toContainEqual(
      expect.objectContaining({ category: "Names" }),
    );
  });

  test("derives Spanish city countries before package dictionary loading", () => {
    const scoped = applyPipelineLanguageScope({
      ...DEFAULT_NATIVE_PIPELINE_CONFIG,
      language: "es",
    });
    const options = defaultDictionaryBundleOptions(scoped);

    expect(options.cityCountries).toContain("MX");
    expect(options.cityCountries).toContain("AR");
    expect(options.nameLanguages).toEqual(["es"]);
  });

  test("all-language package cities cover every supported language scope", () => {
    const options = defaultDictionaryBundleOptions(
      DEFAULT_NATIVE_PIPELINE_CONFIG,
    );
    const supportedCountries = Object.values(languageScopes.languages).flatMap(
      ({ denyListCountries }) => denyListCountries,
    );

    expect(options.cityCountries).toEqual(
      expect.arrayContaining(supportedCountries),
    );
    expect(options.cityCountries).toEqual(
      languageScopes.allLanguageCityCountries,
    );
  });
});
