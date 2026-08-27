# @stll/anonymize-wasm

## 2.9.0

### Minor Changes

- [#479](https://github.com/stella/anonymize/pull/479) [`21cc2c5`](https://github.com/stella/anonymize/commit/21cc2c594e68b7a6a22f9c82330fea8dd6f28b8f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add the cross-runtime `createPipeline` API with exact single-language,
  multi-language, and all-language selection.

## 2.8.3

## 2.8.2

## 2.8.1

## 2.8.0

## 2.7.8

## 2.7.7

## 2.7.6

### Patch Changes

- [#449](https://github.com/stella/anonymize/pull/449) [`2b804b3`](https://github.com/stella/anonymize/commit/2b804b371ca1ec737c2443670881e5777e71bce8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Support loading native assets from a real directory via `STLL_ANONYMIZE_ASSET_DIR`, so the wasm binding initializes inside compiled single binaries (`bun build --compile`), where `import.meta.url`-relative asset URLs resolve against the embedded filesystem and can never reach assets installed on disk.

## 2.7.5

## 2.7.4

## 2.7.3

## 2.7.2

## 2.7.1

## 2.7.0

## 2.6.3

## 2.6.2

## 2.6.1

## 2.6.0

### Minor Changes

- [#407](https://github.com/stella/anonymize/pull/407) [`1e7c6c9`](https://github.com/stella/anonymize/commit/1e7c6c9254e5109558da5f009049fff1a1c81460) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Run the complete Rust binding in ordinary single-thread browser WebAssembly, with full native-surface parity and no cross-origin-isolation, shared-memory, worker, or WASI requirement.

## 2.5.0

## 2.4.2

### Patch Changes

- [#385](https://github.com/stella/anonymize/pull/385) [`92175c0`](https://github.com/stella/anonymize/commit/92175c0bfb7108ac2d249d8625fa0fa83eb0c149) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Load the wasm binding under Bun as well as Node. The napi-rs-generated WASI glue built its WASI from `node:wasi`, whose `WASI` lacks `.initialize()` under Bun (the wasm binding is a reactor module, so emnapi calls `wasi.initialize`), causing `wasi.initialize is not a function`. The Node and threads-worker loaders now use the portable `@napi-rs/wasm-runtime` WASI (already used by the browser loader), so the binding loads and runs identically on both runtimes. A CI runtime matrix runs the wasm smokes under Node and Bun to keep this from regressing.

## 2.4.1

## 2.4.0

## 2.3.0

## 2.2.0

## 2.1.0
