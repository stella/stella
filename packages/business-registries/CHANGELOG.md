# @stll/business-registries

## 0.8.3

### Patch Changes

- [#3736](https://github.com/stella/stella/pull/3736) [`223993a`](https://github.com/stella/stella/commit/223993aa1874d00662f6ecd4e7c86de9bfd601bd) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `orsr.lookupByIco` only considers search hits whose registration number equals the requested IČO, and returns `null` for an extract that names a different IČO. The ORSR search also matches corporate names, so a company named after another's IČO could previously be returned.

## 0.8.2

### Patch Changes

- [#3728](https://github.com/stella/stella/pull/3728) [`0d6bd5a`](https://github.com/stella/stella/commit/0d6bd5abf19cf86f71a6dd71ad9c39b3435fd8f1) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Narrow optional values before they reach rendered text and messages. The outline rail no longer draws a tick for a heading whose id matches an object prototype key.

## 0.8.1

### Patch Changes

- Updated dependencies [[`264593e`](https://github.com/stella/stella/commit/264593e2729be0a11aff8a206ad38451fdb56377)]:
  - @stll/country-codes@0.2.0

## 0.8.0

### Minor Changes

- [#3356](https://github.com/stella/stella/pull/3356) [`52a6f32`](https://github.com/stella/stella/commit/52a6f32afdba36a233eeb1fca402845caeae510a) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Rewrite the built-in default of every company-specification registry into the party-identification clause a local lawyer actually writes, and add the punctuated identifier tokens those clauses need.

  New tokens, for registries whose upstream returns the identifier unpunctuated: `[registry number spaced]` for the Slovak IČO ("31 322 832", grouped `dd ddd ddd`, two digits ahead of the Czech `ddd dd ddd`) and the Norwegian organisasjonsnummer ("923 609 016"); `[SIREN spaced]` and `[SIRET spaced]` for France; `[EIN dashed]` for EDGAR. Slovakia also gains `[court genitive]` over the eight registry courts the 2023 court map left standing, plus `[section]` and `[insert]`.

  New defaults: Slovak cites the register the way the register does ("zapísaná v Obchodnom registri Mestského súdu Bratislava III, oddiel: Sro, vložka č. 3586/B"); Polish identifies the KRS number without claiming a sub-register; French names the siège social and SIREN number without inferring RCS registration; UK preserves the recorded legal form, including partnerships; Norwegian and Finnish follow local party-clause form. A default is now declared as a list of clauses, each naming the particulars it needs, and both the author-facing string and the built-in rendering are derived from that one list, so a record missing a particular drops the whole clause instead of leaving a dangling label. Every retired default is registered in `PREVIOUS_DEFAULT_FORMATS`, so a saved copy keeps rendering as the built-in.

  Two fixes fall out of the same work: the Slovak file reference is cited in the register's own order ("Sro 3586/B", not "B, Sro 3586"), and a KRS REGON that the API right-pads to fourteen characters is unpadded back to the nine-digit number that exists.

## 0.7.0

### Minor Changes

- [#3353](https://github.com/stella/stella/pull/3353) [`61f5d93`](https://github.com/stella/stella/commit/61f5d9372478c2747ad3d021b8adef24fed4b748) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add the genitive court form (`[court genitive]`, "u Městského soudu v Praze") and a grouped identifier (`[registry number spaced]`, "270 82 440") to the ARES company specification tokens. The built-in ARES format now renders the grouped identifier and starts with the company name, without the "společnost" prefix. Saved copies of the previous built-in string keep behaving as the built-in: `isBuiltInRegistryFormat` recognizes previously shipped defaults alongside the current one.

## 0.6.0

### Minor Changes

- [#3274](https://github.com/stella/stella/pull/3274) [`ce1c268`](https://github.com/stella/stella/commit/ce1c268624ab650084f6216931995ee3ea4c9b7d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export registry-specific built-in company formats and distinguish legal company specifications from registry references.

## 0.5.0

### Minor Changes

- [#3161](https://github.com/stella/stella/pull/3161) [`7cd31dd`](https://github.com/stella/stella/commit/7cd31dde35b8fea728de5c4d65bfd41945ba6552) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export shared ARES company-format tokens and support instrumental court names in registry output.

## 0.4.1

### Patch Changes

- [#3141](https://github.com/stella/stella/pull/3141) [`088e15d`](https://github.com/stella/stella/commit/088e15d2cb4c37a1b7f7e5380bbca62ab1704ce2) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Use Temporal for calendar calculations and wall clocks, with a native implementation when available and a bundled fallback otherwise. Preserve serialized timestamps and existing Date-based library interfaces.

## 0.4.0

### Minor Changes

- [#3054](https://github.com/stella/stella/pull/3054) [`8289300`](https://github.com/stella/stella/commit/82893000f1ddbed8ac4dc81ef6b589cf9e401a31) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose ARES legal-form and court names and browser-safe KRS number validation. Preserve fractional share capital and format Czech registry particulars with readable currency and paragraph spacing.

  Preserve full Slovak registry court names and format court references as section, insert number, and court code.

## 0.3.3

### Patch Changes

- [#2947](https://github.com/stella/stella/pull/2947) [`6f86823`](https://github.com/stella/stella/commit/6f86823e5e9eb4f2b2a8027a021063b909ca44e3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Exhaustiveness checks panic instead of returning the unhandled value, and a
  fallback after the assertion counts as returning it.

- [#2972](https://github.com/stella/stella/pull/2972) [`58951e1`](https://github.com/stella/stella/commit/58951e13fa4c181473e19b3ec2d35d19f3fa9bda) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Remove suppression directives for a retired lint rule; no runtime change.

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
