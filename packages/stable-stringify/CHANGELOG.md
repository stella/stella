# @stll/stable-stringify

## 0.2.0

### Minor Changes

- [#2966](https://github.com/stella/stella/pull/2966) [`b65402c`](https://github.com/stella/stella/commit/b65402c1275643db5739fdfaab6156fe5e7524f5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - First release. `stableStringify` gives JSON-shaped values a deterministic string form for fingerprints and cache keys: keys sort in UTF-16 code-unit order, so the output is identical across runtimes and locales. `StableStringifyInput` states the input contract, keeping a `Date`, `Map`, or `Set` — each of which would serialize as `{}` and collide — a compile error at the call site.
