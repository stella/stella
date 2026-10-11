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

Cleanup estimates text-like ink after rectification and deskew, before flattening.
A stroke is a dark valley with at least 15 luminance levels of contrast against
opposing samples 2, 4, or 8 pixels away horizontally or vertically. This targets
narrow strokes rather than broad shaded regions; it does not classify solid
illustrations as text. The estimate is resolution dependent, and strokes wider
than 16 pixels are outside this guard's scope.

At least 75% of these source stroke pixels must retain contrast in grayscale or
remain black in binary, globally and within each cell of an 8 × 8 source grid
containing at least 16 estimated stroke pixels. This prevents retained desk
texture from hiding a separate region of erased text. Grayscale falls back to the unflattened image when this
fails. Binary retries against the unflattened image, then reports `content-loss`
if retention still fails. Content cropping is skipped if the combined processing and cropping would lose
more than 25% of the estimated source strokes globally or in any qualifying
source grid cell. These checks compare corresponding
pixels in the same rectified region; they do not validate a page detection.

Binary classification requires both local-mean darkness and the opposing-sample
stroke contrast. Smooth fold gradients and broad dark box interiors therefore
stay white, while fine text remains black. Use grayscale to preserve solid fills.
When a grayscale image has no binary strokes, its content bounds use absolute
foreground darkness so solid illustrations remain recognized.

Page detection examines both light and dark contours at a maximum side of 750
pixels. Candidates must be convex, cover 6–94% of the frame, have corner angles
of 45–135 degrees and opposing side ratios of 0.5–2. The average side aspect
must fall within 28% of Letter, A-series or Legal proportions, allowing moderate
perspective without assuming a national paper format. Each side needs at least
60% cross-edge contrast support, with at least 6 of 16 samples
in each quarter. Frame-touching contours are rejected. Nearby threshold variants
are clustered; the winner needs a 15% score margin over a distinct runner-up.
These conservative heuristics can miss curved or heavily occluded pages. When
no candidate passes, the engine preserves the full frame and only deskews and
cleans it; content crop is also disabled in this case.

Candidates also need text-like ink in 1–50% of sampled interior pixels,
excluding an 8-pixel boundary band at detection resolution. This prevents blank
furniture rectangles and solid illustrations from becoming false page crops.
Blank sheets and texture-heavy backgrounds deliberately remain uncropped.

Reduced contour sides are shifted outward to enclose every hull vertex; the hull
must occupy at least 78% of the resulting quad. Boundary support searches an
8%-of-side perpendicular band (4–24 detection pixels), accommodating curvature.
Contrast must reach 3 gray levels and exceed twice the variation on the adjacent
flanks, so smooth gradients cannot masquerade as edges. Support and ink are
measured before smoothing; contours use thresholds spaced 5 gray levels apart.

Before warping, a separate high-confidence source-content heuristic checks dark
stroke valleys whose opposing brighter samples reach the source's 90th-percentile
luminance minus 30 levels. This focuses on bright paper regions rather than dark
wood or carpet texture. A candidate must retain 75% of this estimate globally
and in each 8 × 8 source grid cell containing at least the larger of 16 pixels
or 0.5% of the total estimate. Separate qualifying bright text regions outside a
candidate cause conservative full-frame fallback. Dim or colored paper and tiny
exterior text regions are outside this pre-warp heuristic's scope. The processing
and cropping safeguards still check all raw stroke valleys after rectification,
using their original 16-pixel grid-cell threshold.
