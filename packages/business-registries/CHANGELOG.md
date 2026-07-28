# @stll/business-registries

## 0.2.1

### Patch Changes

- [#1425](https://github.com/stella/stella/pull/1425) [`24eb1c4`](https://github.com/stella/stella/commit/24eb1c46b5475f09b279335ec57071accf870a61) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Use the browser-safe stdnum runtime for registry identifier validation and expose an explicit browser initializer.

## 0.2.0

### Minor Changes

- [#1413](https://github.com/stella/stella/pull/1413) [`a2a2669`](https://github.com/stella/stella/commit/a2a2669b810e4fba3a31cf1ff5763b587c761fb4) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add optional request cancellation to the ARES, Zefix,
  recherche-entreprises, SUDREG, and KRS clients while preserving each
  request's timeout.

- [#1406](https://github.com/stella/stella/pull/1406) [`f0e5e95`](https://github.com/stella/stella/commit/f0e5e958774cd01ea8b7cd09d14f010197dfb587) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add browser-safe clients for Switzerland's Zefix API and Croatia's court
  register, plus explicit normalized entity and search-result projections for
  the Czech, Slovak, British, Polish, French, Swiss, and Croatian adapters.
  Publish the canonical country-code types consumed by the registry package.
  Canonicalize registry dates, preserve historical date precision, and reject
  invalid identifiers before branding them.

- [#1414](https://github.com/stella/stella/pull/1414) [`ac4199d`](https://github.com/stella/stella/commit/ac4199df20ed4f4e1de7f4c6b6961396956799a8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Group normalized Companies House officers by role and omit resigned appointments from the current key-people field.

### Patch Changes

- Updated dependencies [[`f0e5e95`](https://github.com/stella/stella/commit/f0e5e958774cd01ea8b7cd09d14f010197dfb587)]:
  - @stll/country-codes@0.1.1
