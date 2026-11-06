# @stll/fetch

## 0.2.0

### Minor Changes

- Return the transport's own `Response` for every timeout policy and remove the misleading transport-level `idle` policy. The new `@stll/fetch/body-reader` export reads a body with an idle deadline that restarts for each chunk and an optional byte limit: `iterateBodyWithIdleDeadline`, `readBodyWithIdleDeadline`, `readBodyTextWithIdleDeadline`, `readBodyJsonWithIdleDeadline` and `BodyByteLimitError`.

## 0.1.1

### Patch Changes

- [#7488](https://github.com/stella/stella/pull/7488) [`569b4a7`](https://github.com/stella/stella/commit/569b4a7f501e3e071d972c2e65422362e2fe3b2f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Hand a request with a numeric deadline straight to the transport and return its response unchanged, bounded by a total deadline on the request signal.

- [#7223](https://github.com/stella/stella/pull/7223) [`8899f5d`](https://github.com/stella/stella/commit/8899f5d2d10eafda2f7d9b5820f64604b2ff2e68) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Apply total request deadlines while response bodies are being consumed.

- [#7507](https://github.com/stella/stella/pull/7507) [`03ac637`](https://github.com/stella/stella/commit/03ac6373005168d48289d78dda0becbe311361de) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Return the transport's response unchanged for an explicit `total` deadline too, bounded through the request signal like the numeric form.

## 0.1.0

### Minor Changes

- [#6759](https://github.com/stella/stella/pull/6759) [`809d621`](https://github.com/stella/stella/commit/809d621af2d7286e4dd4982472c5074f343786ad) Thanks [@jan-kubica](https://github.com/jan-kubica)! - First release: `fetchWithTimeout` with a required headers or idle timeout, `createFetchWithTimeout`, `isConnectionFailure`, and the robots-aware polite fetch in `@stll/fetch/publisher`.
