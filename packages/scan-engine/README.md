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
texture from hiding a separate region of erased text. Grayscale falls back to
the unflattened image when this fails. Binary retries against the unflattened
image, then retries with a zero adaptive-mean offset. If retention still fails,
it drops the adaptive-mean condition and binarises the original opposing-sample
stroke mask. This last
fallback preserves the estimated ink exactly, without admitting smooth shadow
interiors. A failed retention check still reports `content-loss`. Content cropping
is skipped if the combined processing and cropping would lose
more than 25% of the estimated source strokes globally or in any qualifying
source grid cell. These checks compare corresponding
pixels in the same rectified region; they do not validate a page detection.

Preferred binary classification requires both local-mean darkness and the
opposing-sample stroke contrast; the final fallback retains the contrast rule.
Smooth fold gradients and broad dark box interiors therefore
stay white, while fine text remains black. Use grayscale to preserve solid fills.
When a grayscale image has no binary strokes, its content bounds use absolute
foreground darkness so solid illustrations remain recognized.

Page detection examines both light and dark contours at a maximum side of 750
pixels. Convexity and source-frame containment are invariants. Other evidence
forms a continuous score: `geometry^0.20 × support^0.35 × enclosure^0.25 ×
margin^0.20`, accepted at **0.70**. Geometry is the weakest normalized area,
corner-angle, opposing-side-ratio and format-plausibility term. Full confidence
covers 6–94% frame area, 45–135 degree angles, side ratios of 0.5–2 and aspect
within 28% of Letter, A-series or Legal. Confidence declines beyond these bounds;
format confidence reaches zero at 40% deviation.

Support is the weakest side's geometric mean of total supported samples and its
weakest quarter (64 samples per side). A missing quarter gives zero confidence;
strong corners cannot replace a side. Enclosure is the occupied contour area
divided by quad area, capped at one, multiplied by paper coverage. Coverage
counts pixels reaching the candidate’s own 90th-percentile luminance minus 50
levels, or narrow dark strokes surrounded by that brightness. This penalizes
dark scene extensions without penalizing printed ink or dark paper. Coverage
is sampled on a grid spaced four pixels apart at detection resolution. Using the actual contour rather than its
convex hull prevents sparse scene texture from inventing filled page area. Each
contour contributes a tight reduced quad and, when
meaningfully different, a quad whose shifted sides enclose every hull vertex.
The source-content check protects tight candidates against clipped printed
regions. Candidates may touch at most one frame corner; scene-sized border
contours cannot represent a page. Threshold variants whose mean corner distance
is below 8% of the longest frame side are clustered. Candidates rank by their
pre-margin score times `frameAreaFraction^0.10`; this modest size preference
favors a complete sheet over a text block without making scene size dominate
boundary evidence. Margin is the winner's relative rank lead divided by 0.15,
capped at one; it contributes to confidence rather
than independently vetoing every lead below 15%. Equal distinct candidates still
have zero confidence. These heuristics can miss curved or heavily occluded pages.
When no candidate passes, the engine preserves the full frame and only deskews
and cleans it; content crop is also disabled in this case.

Candidates also need text-like ink in 1–50% of sampled interior pixels,
excluding an 8-pixel boundary band at detection resolution. This prevents blank
furniture rectangles and solid illustrations from becoming false page crops.
Blank sheets and texture-heavy backgrounds deliberately remain uncropped.

Boundary support searches an
8%-of-side perpendicular band (4–24 detection pixels), accommodating curvature.
Contrast must reach 3 gray levels and exceed twice the variation on the adjacent
flanks, so smooth gradients cannot masquerade as edges. Support and ink are
measured before smoothing; contours use thresholds spaced 5 gray levels apart.

Before warping, a separate high-confidence source-content heuristic checks dark
stroke valleys whose opposing brighter samples reach the higher of the
candidate's and source's 90th-percentile luminance minus 50 levels. The
paper-relative reference prevents dim wood or leaf texture from vetoing a
supported page. Nearby context extends one quarter of the longest side. Distant
strokes can be excluded only when they contribute at most 25% of the total
estimate; a distant bright screen may be irrelevant, while a crop excluding
most printed evidence must still fail. The global denominator always includes
excluded distant strokes: exclusions cannot compound the 25% loss allowance.
A candidate must retain 75% of the original estimate globally
and 95% in each 8 × 8 source grid cell containing at least the larger of 16 pixels
or 0.5% of the total estimate. Each cluster retains its strongest ranked boundary
and strongest enclosing boundary. If the strongest boundary fails the content check, its enclosing
alternative can preserve a curved sheet.
The content check runs before final ranking; native stroke evidence is computed
once and shared across cluster candidates. Ranking stops once remaining clusters
cannot improve the validated runner-up. Native guards have an aggregate candidate-area budget of 320 million pixels,
charging the source image area once per attempt. Each attempt makes several
image passes; the shared initial cache is outside this budget. Exhausted work
preserves the full frame. Separate qualifying text regions
outside
a candidate cause conservative full-frame fallback. Scene texture within 50
luminance levels of the paper reference may also veto a crop; the guard favors
content preservation when that evidence is ambiguous. Dim or colored paper and tiny
exterior text regions are outside this pre-warp heuristic's scope. The processing
and cropping safeguards still check all raw stroke valleys after rectification,
using their original 16-pixel grid-cell threshold.
