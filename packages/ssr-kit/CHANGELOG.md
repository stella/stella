# @stll/ssr-kit

## 0.2.0

### Minor Changes

- [#3080](https://github.com/stella/stella/pull/3080) [`8dd1f12`](https://github.com/stella/stella/commit/8dd1f12b7cca5e74cd78518a86e605f0e090227b) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Require hydration callbacks to resolve after their render commits, replacing the
  removed `scheduleAfterPaint` option.

## 0.1.1

### Patch Changes

- [#2947](https://github.com/stella/stella/pull/2947) [`6f86823`](https://github.com/stella/stella/commit/6f86823e5e9eb4f2b2a8027a021063b909ca44e3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Exhaustiveness checks panic instead of returning the unhandled value, and a
  fallback after the assertion counts as returning it.

## 0.1.0

### Minor Changes

- [#2892](https://github.com/stella/stella/pull/2892) [`10edc8d`](https://github.com/stella/stella/commit/10edc8d6615afe685c8b14453eece517f372aec7) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Extract reusable SSR path policy, hydration ordering, document assertions, and
  Bun serving primitives from the web application into explicit packages.
