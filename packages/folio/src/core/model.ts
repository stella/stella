/**
 * Folio model seam — the named, pure-data "lingua franca" surface (Seam 2).
 *
 * This barrel is the single entry point for folio's behavior-free data layer:
 * the docx document model, block ids, enum-value tables, the layout/flow data
 * shapes, and the measurement data shapes. It is pure data only — no
 * ProseMirror, no DOM render, no React, no engine behavior. The
 * `folio-layer-boundaries/model-is-pure-data` oxlint rule and the
 * `core/__tests__/model-purity.test.ts` architecture test fence the underlying
 * type modules so behavior can never creep into them.
 *
 * The document model (`types/*`) and the layout/flow model
 * (`layout-engine/types`) share several simple names (`Run`, `TableCell`,
 * `TableRow`) that are distinct types in each layer. To keep this surface
 * lossless rather than silently dropping the colliding names, the document
 * model is re-exported flat and the layout/measure shapes are namespaced
 * (`Layout.FlowBlock`, `Measure.RunMeasurement`).
 *
 * This is an additive, parallel entry: existing imports are unchanged. The
 * physical relocation of these modules under `core/model/` is deferred to the
 * package split.
 */

// Document model: the full docx-core document surface (Document, Paragraph,
// Section, content, hyperlinks, fields, images, tables, styles, theme, …).
// `types/content`, `types/colors`, and `types/formatting` are curated subsets
// of this same origin, so re-exporting `types/document` covers them too.
export type * from "./types/document";

// Block ids: the branded `FolioBlockId` plus its derivation/guard helpers
// (runtime exports, hence `export *`).
export * from "./types/block-id";

// Enum-value tables: the `*_VALUES` arrays and their derived literal types
// (runtime exports, hence `export *`).
export * from "./types/documentEnumValues";

// Layout/flow data model: `FlowBlock`, `ParagraphBlock`, `MeasuredLine`, layout
// runs, and the textbox-margin constants. Namespaced because several names
// (`Run`, `TableCell`, `TableRow`) collide with the document model above while
// being distinct layout types.
export * as Layout from "./layout-engine/types";

// Measurement data shapes: `FontStyle`, `FontMetrics`, `TextMeasurement`,
// `RunMeasurement`. Pure data describing measurement results; the measuring
// behavior lives in the engine, not here.
export type * as Measure from "./layout-engine/measure/measureTypes";
