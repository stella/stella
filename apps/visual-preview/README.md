# @stll/visual-preview

Lambda renderer for composed visual documents. The API and renderer import the
same bounded schemas from `@stll/api-contract/visual-preview`. Rendering uses a
fresh browser with an opaque-origin iframe, intercepted requests, and a fixed
1200-pixel viewport. Missing readiness is reported in the response; rendering
failures are typed errors without document contents.

The image includes a checksum-pinned arm64 Chromium pack. It downloads nothing
at invocation time. Build from the repository root with
`docker build --platform linux/arm64 -f apps/visual-preview/Dockerfile .`.

`test` covers input validation. `test:browser` exercises screenshots, readiness,
diagnostics, HTTP and WebSocket blocking in local Playwright. Install the matching
browser with `install:browser` before running browser tests.
