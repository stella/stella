# Folio seam architecture

Target architecture for folio: a layered set of packages joined by explicit,
typed seams, so that the same engine powers multiple framework adapters
(React, Vue), multiple hosts (web, desktop, server), a future Rust core, headless
agentic editing, and — eventually — additional OOXML formats (pptx, xlsx) as
parallel verticals over a shared substrate.

This doc defines the seams. It is the north star for the phased migration in
[Phased path](#phased-path); we are not there yet.

## Principle

Cut the seams by **reason to change** and **portability profile**, not by
"React or not". Today folio has one coarse seam — `core/` (React-free) vs the
React adapter — which is why the adapter reaches into ~91 core modules: the
boundary is in the wrong place. Replace it with layers where each boundary is a
typed contract.

## Responsibility map

From most-portable (bottom) to most-framework-specific (top).

| Layer           | Owns                                                                                                                                                                           | Profile                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `model`         | Pure data shapes: `Document`, `Layout`, `FlowBlock`, `Measure`, content types, ids                                                                                             | Language-agnostic (→ Rust serde)         |
| `engine`        | Pure compute: OOXML read/write, `Document→FlowBlocks`, pagination/line-break, markdown, pure transforms (fields, content-controls, watermark, style resolution), AI diff/apply | **Rust target.** No DOM, no PM, no React |
| `document`      | Editable model: PM schema, plugins, commands, extensions, `Document↔ProseMirror`                                                                                               | JS forever (ProseMirror is JS)           |
| `render-dom`    | Paint `Layout`→DOM, hit-testing, span mapping, scroll, overlay geometry; the canvas measure provider                                                                           | JS forever, **framework-agnostic DOM**   |
| `controller`    | Headless orchestration: layout loop, incremental measure, hidden PM view, selection/scroll; imperative API + events                                                            | Framework-agnostic JS                    |
| `react` / `vue` | Thin: lifecycle, event wiring, chrome (toolbar/menus/dialogs)                                                                                                                  | Per-framework                            |

`layout-bridge` today **conflates** two concerns: pure `Document→FlowBlocks`
(belongs in `engine`) and DOM hit-testing (belongs in `render-dom`). Splitting
it is part of the migration (P3).

## The seams (the contracts)

Everything crosses these; nothing reaches around them.

### Seam 1 — `MeasureProvider` (the Rust linchpin)

The engine must not know _how_ text is measured.

```ts
interface MeasureProvider {
  measureWidths(reqs: MeasureRequest[]): number[]; // batched, pure
  fontMetrics(fontString: string): FontMetrics; // ascent/descent/lineHeight
  // Phase B (later): shapeRuns(...) -> positioned glyphs
}
type MeasureRequest = {
  text: string;
  font: string;
  letterSpacing: number;
  horizontalScale: number;
};
type FontMetrics = { ascent: number; descent: number; lineHeight: number };
```

Browser supplies a canvas-backed impl; Rust supplies a `rustybuzz`/`fontdb`
impl; a headless/server path supplies either. This single inversion makes the
layout engine pure and Rust-portable, and lets us swap measurement backends.

> Note: this seam already half-exists as `layout-engine/measure/measureWorkerProtocol.ts`
> (a serializable `MeasureRequestEntry[] → width[]` contract fulfilled by a
> stateless worker). P2 generalizes it into `MeasureProvider`.

### Seam 2 — the data lingua franca

`Document`, `Layout`, `FlowBlock`, `Measure` are pure serializable types in
`model`. They are the FFI payload (Rust mirrors them as serde structs). No
behavior.

### Seam 3 — `Document ↔ ProseMirror`

`toDocument(pmDoc)` / `toProseDoc(document)` (today's `fromProseDoc` /
`toProseDoc`). PM is the live editable state; `Document` is what the engine
consumes. **The engine never sees ProseMirror.** Must be incremental-friendly
(convert only changed blocks).

### Seam 4 — `Layout → paint`

Engine emits `Layout` (data); `render-dom` draws it. One-way, pure-data
(already roughly enforced as `layout-engine → layout-painter`). Design `Layout`
to optionally carry positioned-glyph data so Phase-B shaping is additive.

### Seam 5 — `FolioHost` (environment capabilities)

```ts
interface FolioHost {
  measureProvider: MeasureProvider;
  loadFont(spec: FontSpec): Promise<FontResource>;
  readFile?(path: string): Promise<Uint8Array>; // desktop; absent on web
  writeFile?(path: string, bytes: Uint8Array): Promise<void>;
  schedule(cb: () => void): void; // raf vs immediate
}
```

Web, Tauri/Electrobun, and Node each provide a different host. The engine and
controller stay identical across web/desktop/server.

### Seam 6 — `FolioEditor` (headless API + events; the Vue/desktop linchpin)

```ts
interface FolioEditor {
  mount(container: HTMLElement): void;
  loadDocx(bytes: Uint8Array): Promise<void>;
  getDocx(): Promise<Uint8Array>;
  commands: { applyStyle(...): void; insertTable(...): void; /* ... */ };
  on(evt: "selectionChange" | "docChange" | "layoutComplete", cb: () => void): () => void;
  destroy(): void;
}
```

Framework adapters only instantiate this, forward lifecycle/events, and render
chrome. The editor _surface_ (pages) is painted imperatively by `render-dom`.

### Seam 7 — Operation / Edit API (the agentic surface)

A stable, versioned, documented schema of edit operations over `Document`
(insert/replace/redline/fill-template/restructure), applied deterministically by
the engine with tracked-change provenance (built on today's `ai-edits`
apply/snapshot/diff). Agents emit ops as JSON; the engine applies them headless.
Addressing uses stable, simple ids (block-id/para-id), never raw UUIDs.

## Dependency direction (strictly one-way)

```
model  <-  engine  <-  measure-impl
  ^          ^
document(PM) |
  ^          |
render-dom --'        (render-dom uses model + Layout; ideally PM-free)
  ^
controller  ->  engine, document, render-dom, host
  ^
react / vue  ->  controller
```

`engine` depends only on `model` + the `MeasureProvider` interface. Adapters
depend only on the `controller` API. The 91 reach-ins collapse to
`adapter → FolioEditor`.

## The measurement crux

Seam 1 is the linchpin and the hardest part, because of a fidelity fork:

- **Phase A:** provider returns advance _widths_; engine breaks lines; the
  painter still emits text as DOM and lets the browser shape glyphs. Cheap, but
  Rust-measured widths can drift from browser rendering.
- **Phase B:** provider returns _positioned glyphs_; painter blits them; the
  browser does no text layout. Fully deterministic and Rust-owned, and the only
  honest path for Arabic/RTL/complex-script fidelity (shaping, not just width).
  Bigger painter change.

Design `Layout` to carry optional glyph positions from day one so B is additive.
Fonts must be provisioned identically to `measure` and `paint` (same fallback
chain) or layout drifts — a sub-problem of Seam 5.

## Incremental layout & async transport (desktop)

Don't re-serialize the whole `Document` per keystroke. Model the
controller↔engine contract as a stateful `LayoutSession` (which holds cached
measures and the previous layout, fed dirty ranges). Make its methods
**async-tolerant** (promise-returning) from the start: in the browser a
WASM/worker call is effectively in-process, but on desktop the engine may live
across a Tauri IPC or napi boundary, or off the UI thread. An async interface
preserves that option at
no cost to the JS path.

## Multi-format substrate (docx, pptx, …)

docx and pptx share the OOXML container (zip / `[Content_Types].xml` / `.rels` /
parts), DrawingML (shapes, images, charts, text-in-shapes), and theme/fonts.
They diverge at the model (flowing WordprocessingML vs spatial PresentationML),
layout (pagination/reflow vs fixed slide canvas with in-shape autofit), and
editing (PM flow vs shape canvas). So formats are **parallel verticals over a
shared substrate**, not a fork:

```
@folio/ooxml    container (zip/parts/rels), DrawingML, theme/fonts   [shared]
@folio/measure  text shaping/measure seam                            [shared]
@folio/host     capabilities                                         [shared]
   |- docx: model(Document)     + engine(flow/paginate) + render(pages)  + PM-flow editing
   '- pptx: model(Presentation) + engine(slide layout)  + render(canvas) + shape editing
```

The `MeasureProvider`, `FolioHost`, the WASM/native build, the controller/event
pattern, and the agentic op pattern are all format-agnostic. If pptx is a real
goal, draw the `@folio/ooxml` substrate boundary while carving the docx seams
(P1–P3) so it is shared by construction.

## Phased path

Each phase ships in the monorepo, CI-checked. P1–P4 are pure TS refactors that
also improve the current product (testability, clarity); you can stop after any
phase with a strictly better codebase.

- **P0 (done, #884):** React-free core (`no-react-in-core` rule + arch test),
  headless `@stll/folio/core` entry, `paged-layout` moved into core.
- **P1 (done, #887) — model seam:** `core/model.ts` lingua-franca barrel + the
  `model-is-pure-data` lint rule. Physical `types/`→`model/` relocation (~246
  imports) deferred to P5.
- **P2 (done, #887) — measurement seam:** `MeasureProvider` (P2a) + the layout
  engine's import graph made canvas-free (P2b). Headless-testable, Rust-ready.
- **P4 (next) — extract the headless `controller`:** pull orchestration (layout
  loop, incremental measure, hidden PM view, selection/scroll) out of
  `paged-editor` into a framework-agnostic controller with an imperative API +
  events. The React adapter becomes a thin wrapper. This is the Vue/desktop
  linchpin and is self-contained.
- **P5 — package the boundaries (incl. the bridge split):** form the `engine` /
  `document` / `render-dom` packages and dissolve `layout-bridge` into them. The
  bridge split (originally "P3") folds in here: the bridge is a cohesive
  PM→FlowBlocks→measure cluster, so cleanly separating its pure-compute,
  PM-conversion, and DOM pieces only works once those three packages exist as
  homes — doing it earlier would mean throwaway intermediate dirs. The
  standalone-repo extraction also happens here.
- **P6 — `@folio/vue`:** small if P4–P5 are right.
- **P7 — Rust port (profiled):** `docx` I/O first (no font stack), then layout
  (with a Rust measure provider).

## Status

P0, P1, and P2 are merged (#884, #886, #887): the React-free core, the model
seam, and the fully-inverted measurement seam are in. **P4 (the headless
controller) is next** — it's self-contained and is the Vue/desktop enabler. The
bridge split folded into P5 (see P5 above) because cleanly separating that
cluster requires the engine/document/render-dom package homes that P5 creates.
