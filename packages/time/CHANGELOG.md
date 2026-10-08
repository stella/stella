# @stll/time

## 0.3.0

### Minor Changes

- [#4760](https://github.com/stella/stella/pull/4760) [`c17c9b8`](https://github.com/stella/stella/commit/c17c9b88822a27615a99baa589dd54d66ef4b666) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `parseTimeZoneId(value)` and the `TimeZoneId` brand: an IANA time-zone id read the way the runtime's tz database spells it; fixed UTC offsets are refused.

### Patch Changes

- [#4834](https://github.com/stella/stella/pull/4834) [`9a1473c`](https://github.com/stella/stella/commit/9a1473cba3f3440878fc7bdc9a5c74b148705428) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Importing `@stll/time` no longer calls `Temporal` at module load, so it loads where the runtime's `Temporal` is partial.

## 0.2.0

### Minor Changes

- [#4724](https://github.com/stella/stella/pull/4724) [`6a78bd5`](https://github.com/stella/stella/commit/6a78bd510e807883521924bbaf38afe2be5e84f3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `todayFor(zone, at?)`, the calendar day a person in an IANA time zone sees at an instant.

## 0.1.0

### Minor Changes

- [#4034](https://github.com/stella/stella/pull/4034) [`ed157f2`](https://github.com/stella/stella/commit/ed157f2f2f445bdda2575f6cc51ecf922be5057f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - First release.
