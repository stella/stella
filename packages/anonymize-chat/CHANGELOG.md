# @stll/anonymize-chat

## 0.2.4

### Patch Changes

- Updated dependencies [[`5a279ca`](https://github.com/stella/stella/commit/5a279cac4dcaa80087c6c92f2e621ad124c661d9)]:
  - @stll/text-normalize@0.5.1

## 0.2.3

### Patch Changes

- Updated dependencies [[`0ecb2de`](https://github.com/stella/stella/commit/0ecb2de044bc19abd46d44ac933d0f3c1cd724ef), [`15e7031`](https://github.com/stella/stella/commit/15e7031924012f3998e399392d1add7eb603583d)]:
  - @stll/text-normalize@0.5.0

## 0.2.2

### Patch Changes

- Updated dependencies [[`c89ddbb`](https://github.com/stella/stella/commit/c89ddbb42c973e447f05dcf0f30c124b7462824b)]:
  - @stll/text-normalize@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`df74ff6`](https://github.com/stella/stella/commit/df74ff6f4cd3947f948a5d2b227ecb852ae4f24a), [`3e92069`](https://github.com/stella/stella/commit/3e92069e5fb6a491f432adc849aef76e993805e7)]:
  - @stll/text-normalize@0.3.0

## 0.2.0

### Minor Changes

- [#5538](https://github.com/stella/stella/pull/5538) [`d532682`](https://github.com/stella/stella/commit/d5326822357958276e9fbfae7eabf009a9a3a5e3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Centralize Unicode normalization and mark stripping in `@stll/text-normalize` and use the shared behavior in dependent packages.

### Patch Changes

- Updated dependencies [[`d532682`](https://github.com/stella/stella/commit/d5326822357958276e9fbfae7eabf009a9a3a5e3)]:
  - @stll/text-normalize@0.2.0

## 0.1.8

### Patch Changes

- [#4912](https://github.com/stella/stella/pull/4912) [`ada25c9`](https://github.com/stella/stella/commit/ada25c9cb4373464bc37a2ab973d9bcb4efd6216) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Update `@stll/anonymize-wasm` to 3.0.7.

## 0.1.7

### Patch Changes

- [#4785](https://github.com/stella/stella/pull/4785) [`26371e6`](https://github.com/stella/stella/commit/26371e6d32facb5ca5ac06a69a3a6fbf9ea5d091) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Use `@stll/anonymize-wasm` 3.0.6.

## 0.1.6

### Patch Changes

- [#4472](https://github.com/stella/stella/pull/4472) [`589904e`](https://github.com/stella/stella/commit/589904e42e498fc38468d271e5c4f7f4957e70ec) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Update @stll/anonymize-wasm to 3.0.4.

## 0.1.5

### Patch Changes

- [#4420](https://github.com/stella/stella/pull/4420) [`bbfe144`](https://github.com/stella/stella/commit/bbfe1443266768f70eee1a22ec3b77caf775c252) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Update @stll/anonymize-wasm to 3.0.3.

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
