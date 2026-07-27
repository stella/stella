# Changelog

## 0.0.9 (2026-07-27)

### Breaking

- Move the city API to the `@stll/anonymize-data/cities` subpath:
  `loadCityDictionary`, `loadCityDictionaries`, `hasCityDictionary`,
  `CITY_DICTIONARY_COUNTRIES`, `CITY_DICTIONARY_META`, `loadDictionaryBundle`,
  and the `DictionaryBundle` / `LoadDictionaryBundleOptions` types. The root
  entry no longer exports them.

  The city loader map holds one literal `import()` per covered country, so a
  bundler emitted all 237 city chunks (~815 KiB) for any consumer that touched
  the root entry, even one that only loaded name dictionaries. The root entry's
  module graph can no longer reach the loader map, and a test enforces it.

  Update imports of the listed symbols to `@stll/anonymize-data/cities`; the
  rest of the root surface is unchanged.

## 0.0.8 (2026-07-27)

### Fixes

- Load city dictionaries through literal `import()` specifiers. The previous
  computed specifier could not be rewritten by any bundler, so every bundled
  consumer silently received empty city lists and under-redacted places.
- A covered country whose dictionary fails to load now throws instead of
  returning an empty list; uncovered countries still return an explicit empty.
  New `hasCityDictionary()` and `CITY_DICTIONARY_COUNTRIES` exports make the
  distinction checkable.

## 0.0.7 (2026-07-24)

### Fixes

- Publish language-scoped legal address exits, conjunctions, unit designators,
  and in-name connectors used by the runtime pipeline.
- Add labeled clinical identifier triggers across every supported content
  language.
- Refresh the English first-name data used by the legal-document pipeline.

## 0.0.6 (2026-05-17)

### Fixes

- Bring `config/` into byte-parity with the runtime tree at
  `packages/anonymize/src/data/`. Affected files: `allow-list.json`,
  `common-words-en.json`, `legal-form-leading-clauses.json`,
  `person-stopwords.json`, `triggers.en.json`, `triggers.fr.json`.
- Publish the full dictionary catalog referenced by the data package exports.
- Document the data package surface more clearly for consumers and maintainers.

## 0.0.1 (2026-03-22)

### Features

- Initial release
- 21 config files (triggers, names, legal forms,
  honorifics, coreference, stopwords)
- 315+ dictionary files (banks, cities, streets,
  country names)
- Coverage: CZ, SK, DE, AT, EN, FR, ES, IT, PL,
  HU, RO, SV, and more
