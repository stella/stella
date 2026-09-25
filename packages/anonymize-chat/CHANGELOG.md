# @stll/anonymize-chat

## 0.1.4

### Patch Changes

- [#3733](https://github.com/stella/stella/pull/3733) [`baf3942`](https://github.com/stella/stella/commit/baf3942ca885c16b7b9542f3cc2fb8b1e8a15f84) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Invalid input now raises a tagged error (`ChatAnonInputLimitError` in anonymize-chat) or a `Panic` (resource calendar) instead of a native `RangeError` or `TypeError`.

## 0.1.3

### Patch Changes

- [#3418](https://github.com/stella/stella/pull/3418) [`aa29443`](https://github.com/stella/stella/commit/aa294433bd3b0880f991a9abe1598d4fc50bf7aa) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export the exclusion comparison key so document exports use the same normalization as the anonymization pipeline.

  Update the anonymization runtime to 3.0.1 to preserve source byte offsets when resolving entities with normalized whitespace.

## 0.1.2

### Patch Changes

- [#2539](https://github.com/stella/stella/pull/2539) [`9d34a6e`](https://github.com/stella/stella/commit/9d34a6e56cb1a68a38feee175a7540b877e5b4f1) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Align chat name-corpus locale hints with the anonymization runtime's supported language contract, including regional Portuguese normalization and all-language fallback for unsupported locales.

## 0.1.1

### Patch Changes

- [#2372](https://github.com/stella/stella/pull/2372) [`425b628`](https://github.com/stella/stella/commit/425b6285ee00f22cebcb5635f4433dcb1938d841) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Use canonical Valibot guards and discard unmodeled registry and OAuth response fields.

## 0.1.0

### Minor Changes

- [#2343](https://github.com/stella/stella/pull/2343) [`7434f4c`](https://github.com/stella/stella/commit/7434f4ca59ed432548d1e96d28c8965b6bd2a130) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Publish the provider-neutral model catalogue and placeholder-safe reversible
  anonymization pipeline as supported packages. Add exact sensitive-value inputs
  to the anonymization pipeline so callers can protect identifiers in the same
  redaction allocation as detected entities, and expose placeholder scanning so
  hosts can reject unknown response tokens before restoration.
