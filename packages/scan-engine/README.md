# `@stll/scan-engine`

Document scan cleanup engine implemented in Rust and compiled to WebAssembly.

Run `bun run build:wasm` to build the WebAssembly target and its web bindings
(it fetches crates and the pinned `wasm-bindgen` CLI first unless
`CARGO_NET_OFFLINE=true`). To verify the committed copy, build into a scratch
directory and compare:

```sh
export SCAN_ENGINE_WASM_OUT_DIR="$(mktemp -d)"
bun run build:wasm && bun run check:wasm --check
```

Generated bindings in `generated/` are committed so package consumers receive the
JavaScript glue and WebAssembly binary.
