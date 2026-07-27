/**
 * Test helper: loads dictionaries from @stll/anonymize-data
 * and returns a Dictionaries object suitable for injection
 * into PipelineConfig.
 *
 * Only used in tests — production consumers load and pass
 * dictionaries themselves.
 */
import type { Dictionaries } from "../types";

type TestDictionaryScope = {
  denyListCountries?: readonly string[];
  nameCorpusLanguages?: readonly string[];
};

const cache = new Map<string, Dictionaries>();

const scopeKey = (scope: TestDictionaryScope): string =>
  JSON.stringify({
    denyListCountries: [...(scope.denyListCountries ?? [])].toSorted(),
    nameCorpusLanguages: [...(scope.nameCorpusLanguages ?? [])].toSorted(),
  });

export const loadTestDictionaries = async (
  scope: TestDictionaryScope = {},
): Promise<Dictionaries> => {
  const key = scopeKey(scope);
  const cached = cache.get(key);
  if (cached) return cached;
  const dataModule = await import("../../../data/dictionaries/cities");
  const bundleOptions: Parameters<typeof dataModule.loadDictionaryBundle>[0] =
    {};
  if (scope.denyListCountries !== undefined) {
    bundleOptions.countries = scope.denyListCountries;
    bundleOptions.cityCountries = scope.denyListCountries;
  }
  if (scope.nameCorpusLanguages !== undefined) {
    bundleOptions.nameLanguages = scope.nameCorpusLanguages;
  }

  const result: Dictionaries = {
    ...(await dataModule.loadDictionaryBundle(bundleOptions)),
  };

  cache.set(key, result);
  return result;
};
