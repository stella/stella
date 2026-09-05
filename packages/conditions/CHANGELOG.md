# @stll/conditions

## 0.3.1

### Patch Changes

- [#2947](https://github.com/stella/stella/pull/2947) [`6f86823`](https://github.com/stella/stella/commit/6f86823e5e9eb4f2b2a8027a021063b909ca44e3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Exhaustiveness checks panic instead of returning the unhandled value, and a
  fallback after the assertion counts as returning it.

## 0.3.0

### Minor Changes

- [#2827](https://github.com/stella/stella/pull/2827) [`45b076c`](https://github.com/stella/stella/commit/45b076ca5ea2c97b1534e7ee2493b0272064194b) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export `isEffectiveLeaf`, a pure structural check for whether a `compare`/`predicate` leaf compiles to a real restriction or to nothing, so every consumer that reads which leaves a filter tree keeps agrees on the same rule.

- [#2819](https://github.com/stella/stella/pull/2819) [`67baa75`](https://github.com/stella/stella/commit/67baa75ca462fdb72ef9709e7dd3c7752a03411f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export `foldCondition`/`foldConditions`, a generic fold over the condition tree that owns the drop rule for a group with no surviving children, so every consumer that reads which nodes a filter compiles to agrees on the same structural semantics.

## 0.2.0

### Minor Changes

- [#1200](https://github.com/stella/stella/pull/1200) [`7e53091`](https://github.com/stella/stella/commit/7e53091060df479830961d7be7948f2bdef739c2) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add legal-list capabilities to the CLI and expose nested entity-kind condition matching.

### Patch Changes

- [#1832](https://github.com/stella/stella/pull/1832) [`b4b7cae`](https://github.com/stella/stella/commit/b4b7caedbe543ae3c1ff14e4eec96a27964a1680) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Harden runtime handling of malformed external-data responses and unsupported condition variants.

## 0.1.1

### Patch Changes

- [#1724](https://github.com/stella/stella/pull/1724) [`982d9bb`](https://github.com/stella/stella/commit/982d9bb47e5fd0b7ff5503fbe2fec776784a98ea) Thanks [@shanehobson](https://github.com/shanehobson)! - Treat a comparison against a blank literal as an incomplete filter for every
  operator. `pruneIncomplete` previously excepted `eq`/`neq`, so a filter seeded
  by a picker and never given a value compiled to a real constraint and matched
  almost nothing. Blankness is expressed by `is_empty`.

## 0.1.0

- Initial public release.
