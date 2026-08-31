# @stll/business-registries

## 0.3.2

### Patch Changes

- [#2672](https://github.com/stella/stella/pull/2672) [`6b5d02c`](https://github.com/stella/stella/commit/6b5d02c144aa0fa053e0d8e4a3de4e65bdc14c73) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Serve README banners from the shared repository assets instead of packaging a
  private copy with each package.
- Updated dependencies [[`6b5d02c`](https://github.com/stella/stella/commit/6b5d02c144aa0fa053e0d8e4a3de4e65bdc14c73)]:
  - @stll/country-codes@0.1.2

## 0.3.1

### Patch Changes

- [#2391](https://github.com/stella/stella/pull/2391) [`bea13cb`](https://github.com/stella/stella/commit/bea13cbebf9847a01f83671d293e5a202078b627) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Bump `@stll/stdnum` to 2.3.2, whose loader resolves the native binding through literal requires so bundlers embed it.

## 0.3.0

### Minor Changes

- [#1812](https://github.com/stella/stella/pull/1812) [`93304d8`](https://github.com/stella/stella/commit/93304d8a9e682336c1a30ef5bc4176d4d0323fc8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose actionable document-processing states and retryable ARES failures through stella MCP clients.

### Patch Changes

- [#1832](https://github.com/stella/stella/pull/1832) [`b4b7cae`](https://github.com/stella/stella/commit/b4b7caedbe543ae3c1ff14e4eec96a27964a1680) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Harden runtime handling of malformed external-data responses and unsupported condition variants.

## 0.2.2

### Patch Changes

- [#1439](https://github.com/stella/stella/pull/1439) [`e5997fb`](https://github.com/stella/stella/commit/e5997fb782bb5e7df0abec4568d478922a182c96) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Update the stdnum runtime dependency.

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
