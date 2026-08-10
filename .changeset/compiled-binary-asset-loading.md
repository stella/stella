---
"@stll/anonymize-wasm": patch
---

Support loading native assets from a real directory via `STLL_ANONYMIZE_ASSET_DIR`, so the wasm binding initializes inside compiled single binaries (`bun build --compile`), where `import.meta.url`-relative asset URLs resolve against the embedded filesystem and can never reach assets installed on disk.
