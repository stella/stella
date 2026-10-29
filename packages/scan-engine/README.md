# `@stll/scan-engine`

Document scan cleanup engine implemented in Rust and compiled to WebAssembly:
deskew, content crop and grayscale or binary output for one rasterized page at
a time, plus an engine-independent review state machine for accepting or
rejecting the result page by page.

## Usage

```ts
import { createScanEngine } from "@stll/scan-engine";

const engine = createScanEngine();

const result = await engine.clean(
  {
    pixels, // Uint8ClampedArray of RGBA pixels, e.g. ImageData.data
    width,
    height,
    pageSize: { widthPoints: 595, heightPoints: 842 },
    dpi: 150,
    rotation: 0, // 0 | 90 | 180 | 270
  },
  { output: "binary", contentCrop: "on", deskew: "on" },
);

if (result.isErr()) {
  // ScanEngineError: { type: "engine-failure" | "engine-timeout", message }
} else if (result.value.type === "cleaned") {
  const { image, skewDegrees, contentBox, appliedQuad } = result.value;
  // image.pixels holds one byte per pixel (image.width × image.height).
} else {
  // { type: "unrecognized", reason }, e.g. "no-content" for a blank page.
}
```

`clean` returns a `better-result` `Result` and never throws. Where `Worker`
exists (browsers, Bun), the engine runs in a module worker that it creates on
the first call; requests are serialized, and a request that takes longer than
10 seconds terminates the worker and fails with `engine-timeout`. The next call
starts a fresh worker. `createScanEngine(undefined, { requestTimeoutMs })`
changes the timeout. `scanEngine` is a shared instance of the default engine.

Options:

- `output`: `"grayscale"` or `"binary"` (pixels are strictly `0` or `255`).
- `contentCrop`: `"on"` crops to the detected content; `contentBox` gives
  its bounds in the output image either way.
- `deskew`: `"on"` rotates the page straight; `skewDegrees` reports the
  detected angle, and deskewing grows the output to contain the rotated page.

Types (`RasterizedScanPage`, `ScanOptions`, `CleanScanResult`, `ScanEngine`,
`ScanEngineError`, …) are exported from `@stll/scan-engine/types`.

## Review

`@stll/scan-engine/review` tracks each page through `pending`, `preview`,
`applied`, `rejected` and `unrecognized`, with undo. It works with any
`ScanEngine`.

```ts
import {
  applyAll,
  applyOne,
  createCleanScanReview,
  rejectOne,
  reviewPage,
  setPageReview,
  targetPageBox,
  undoCleanScanReview,
} from "@stll/scan-engine/review";

let review = createCleanScanReview(["page-1", "page-2"]);

const pageReview = await reviewPage({
  engine,
  pageId: "page-1",
  page,
  options,
});
if (pageReview.isOk()) {
  review = setPageReview(review, pageReview.value); // preview or unrecognized
}
review = applyOne(review, "page-1"); // or rejectOne, or applyAll
review = undoCleanScanReview(review);
```

Every transition returns a new review; one that changes nothing returns the
same object and records no undo step. `targetPageBox(pageSize, rotation)`
gives the page box, in points, to place a cleaned image into.

## Bundlers

The package loads `dist/scan-engine.worker.js` and
`generated/scan_engine_bg.wasm` with `new URL(…, import.meta.url)`, so the
bundler has to see those expressions in the installed package. Vite 8 rewrites
them in both `vite dev` and `vite build` with no configuration. If an older
Vite's dependency pre-bundling leaves them pointing into its cache directory
(the worker or the `.wasm` then fails to load in `vite dev` only), exclude the
package so the URLs resolve against its own files:

```ts
// vite.config.ts
export default defineConfig({
  optimizeDeps: { exclude: ["@stll/scan-engine"] },
});
```

## Development

Run `bun run build:wasm` to build the WebAssembly target and its web bindings
(it fetches crates and the pinned `wasm-bindgen` CLI first unless
`CARGO_NET_OFFLINE=true`). To verify the committed copy, build into a scratch
directory and compare:

```sh
export SCAN_ENGINE_WASM_OUT_DIR="$(mktemp -d)"
bun run build:wasm && bun run check:wasm --check
```

Generated bindings in `generated/` are committed and ship in the package next
to `dist/`.
