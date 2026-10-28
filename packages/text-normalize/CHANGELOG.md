# @stll/text-normalize

## 0.5.0

### Minor Changes

- [#7088](https://github.com/stella/stella/pull/7088) [`0ecb2de`](https://github.com/stella/stella/commit/0ecb2de044bc19abd46d44ac933d0f3c1cd724ef) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `foldLikePostgresSearch`, `foldLikePostgresSearchWithOffsets` and `findPostgresSearchFoldRanges` at `@stll/text-normalize/postgres-search-fold`: PostgreSQL's `lower(unaccent(...))` reproduced code point for code point, with offsets back into the original text, for highlighting exactly what a server-side `unaccent` match found. `POSTGRES_UNACCENT_RULES` (`@stll/text-normalize/unaccent-rules`) is the extension's full default rule set.

- [#7087](https://github.com/stella/stella/pull/7087) [`15e7031`](https://github.com/stella/stella/commit/15e7031924012f3998e399392d1add7eb603583d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `slugify` with the `ascii` charset transliterates Latin letters instead of dropping them: accented letters lose their marks (`café` is `cafe`), and letters with no decomposition follow the `unaccent()` table (`Łódź` is `lodz`, `Straße` is `strasse`, `Æsir` is `aesir`). Keys minted earlier are not recomputed; a caller that re-derives a stored key must recognise both forms.

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
