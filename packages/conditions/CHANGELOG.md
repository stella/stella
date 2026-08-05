# @stll/conditions

## 0.1.1

### Patch Changes

- [#1724](https://github.com/stella/stella/pull/1724) [`982d9bb`](https://github.com/stella/stella/commit/982d9bb47e5fd0b7ff5503fbe2fec776784a98ea) Thanks [@shanehobson](https://github.com/shanehobson)! - Treat a comparison against a blank literal as an incomplete filter for every
  operator. `pruneIncomplete` previously excepted `eq`/`neq`, so a filter seeded
  by a picker and never given a value compiled to a real constraint and matched
  almost nothing. Blankness is expressed by `is_empty`.

## 0.1.0

- Initial public release.
