# @stll/country-codes

## 0.2.0

### Minor Changes

- [#3493](https://github.com/stella/stella/pull/3493) [`264593e`](https://github.com/stella/stella/commit/264593e2729be0a11aff8a206ad38451fdb56377) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add the ISO 3166-1 alpha-3 half of the standard: `COUNTRY_ALPHA3_BY_CODE`,
  `COUNTRY_ALPHA3_CODES`, `countryCodeFromAlpha3` and `isCountryAlpha3Code`.
  Alpha-3 is the spelling legal corpora and ELI identifiers use, so both halves
  of ISO 3166-1 now come from one package. The lookups index the table by
  `CountryCode`, so a code added to `COUNTRY_CODES` without an alpha-3 fails to
  compile instead of resolving to undefined.

## 0.1.2

### Patch Changes

- [#2672](https://github.com/stella/stella/pull/2672) [`6b5d02c`](https://github.com/stella/stella/commit/6b5d02c144aa0fa053e0d8e4a3de4e65bdc14c73) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Serve README banners from the shared repository assets instead of packaging a
  private copy with each package.

## 0.1.1

### Patch Changes

- [#1406](https://github.com/stella/stella/pull/1406) [`f0e5e95`](https://github.com/stella/stella/commit/f0e5e958774cd01ea8b7cd09d14f010197dfb587) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add browser-safe clients for Switzerland's Zefix API and Croatia's court
  register, plus explicit normalized entity and search-result projections for
  the Czech, Slovak, British, Polish, French, Swiss, and Croatian adapters.
  Publish the canonical country-code types consumed by the registry package.
  Canonicalize registry dates, preserve historical date precision, and reject
  invalid identifiers before branding them.
