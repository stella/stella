# @stll/country-codes

## 0.1.1

### Patch Changes

- [#1406](https://github.com/stella/stella/pull/1406) [`f0e5e95`](https://github.com/stella/stella/commit/f0e5e958774cd01ea8b7cd09d14f010197dfb587) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add browser-safe clients for Switzerland's Zefix API and Croatia's court
  register, plus explicit normalized entity and search-result projections for
  the Czech, Slovak, British, Polish, French, Swiss, and Croatian adapters.
  Publish the canonical country-code types consumed by the registry package.
  Canonicalize registry dates, preserve historical date precision, and reject
  invalid identifiers before branding them.
