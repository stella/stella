# @stll/anonymize-wasm

## 2.5.0

## 2.4.2

### Patch Changes

- [#385](https://github.com/stella/anonymize/pull/385) [`92175c0`](https://github.com/stella/anonymize/commit/92175c0bfb7108ac2d249d8625fa0fa83eb0c149) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Load the wasm binding under Bun as well as Node. The napi-rs-generated WASI glue built its WASI from `node:wasi`, whose `WASI` lacks `.initialize()` under Bun (the wasm binding is a reactor module, so emnapi calls `wasi.initialize`), causing `wasi.initialize is not a function`. The Node and threads-worker loaders now use the portable `@napi-rs/wasm-runtime` WASI (already used by the browser loader), so the binding loads and runs identically on both runtimes. A CI runtime matrix runs the wasm smokes under Node and Bun to keep this from regressing.

## 2.4.1

## 2.4.0

## 2.3.0

## 2.2.0

## 2.1.0
