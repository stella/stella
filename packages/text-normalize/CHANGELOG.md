# @stll/text-normalize

## 0.4.0

### Minor Changes

- [#7056](https://github.com/stella/stella/pull/7056) [`c89ddbb`](https://github.com/stella/stella/commit/c89ddbb42c973e447f05dcf0f30c124b7462824b) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `createSearchQueryMatcher` and `filterBySearchQuery` at `@stll/text-normalize/search-query-matcher`: the client-side match for user-typed queries. Both sides fold through `foldSearchMatchText`, so case, accents, `ß`/`ł`/`ø`, ligatures and Arabic variants are ignored the same way in every locale.

## 0.3.0

### Minor Changes

- [#6049](https://github.com/stella/stella/pull/6049) [`df74ff6`](https://github.com/stella/stella/commit/df74ff6f4cd3947f948a5d2b227ecb852ae4f24a) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose literal substring matching and bounded UTF-16 match ranges for caller-prepared search keys.

  Replace lone surrogates with U+FFFD on both sides before match-key searches, retaining UTF-16 offsets.

### Patch Changes

- [#5099](https://github.com/stella/stella/pull/5099) [`3e92069`](https://github.com/stella/stella/commit/3e92069e5fb6a491f432adc849aef76e993805e7) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `stripDiacritics`, `foldToAscii`, and `foldSearchMatchText` keep non-Latin spacing marks such as `ー` and `·` instead of deleting them.

## 0.2.0

### Minor Changes

- [#5538](https://github.com/stella/stella/pull/5538) [`d532682`](https://github.com/stella/stella/commit/d5326822357958276e9fbfae7eabf009a9a3a5e3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Centralize Unicode normalization and mark stripping in `@stll/text-normalize` and use the shared behavior in dependent packages.

## 0.1.1

### Patch Changes

- [#4256](https://github.com/stella/stella/pull/4256) [`1ad122e`](https://github.com/stella/stella/commit/1ad122e1f508e9d063755579febf5cb4cd015985) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Tighten input handling.

## 0.1.0

### Minor Changes

- [#4034](https://github.com/stella/stella/pull/4034) [`ed157f2`](https://github.com/stella/stella/commit/ed157f2f2f445bdda2575f6cc51ecf922be5057f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - First release.
