/**
 * Types for the DOCX-document → Markdown converter (ported from eigenpal
 * /docx-editor PR #595). This is folio's v1 surface: the synchronous,
 * continuous (non-paged) `toMarkdown(Document)` path. The paged + async +
 * image-handler variants from upstream are not ported (skills bodies have no
 * images today); they can be added later if needed.
 */

/**
 * Metadata describing a single image registration. Owned by the markdown
 * module so its public surface is independent of the docx model's drawing
 * types.
 */
export type ImageMeta = {
  /** `paraId` of the containing paragraph, when the source paragraph has one. */
  paraId?: string | undefined;
  /** 1-based ordinal in registration order. Unique per render call. */
  index: number;
  /** Path inside the DOCX zip (e.g. `word/media/image1.png`). */
  originalPath: string;
  /** MIME type (`image/png`, `image/jpeg`, …). */
  mimeType: string;
  /** Alt text from the drawing, when present. */
  alt?: string | undefined;
};

/** Full registration record for an image, keyed by `virtualPath`. */
export type ImageRef = {
  /** Raw bytes as exposed by the DOCX parser. */
  data: Uint8Array;
  /** Base64-encoded contents, without the `data:` prefix. */
  base64: string;
  /** `data:<mime>;base64,<base64>` URL. */
  dataUrl: string;
  /** The path that appears inside the markdown's `![alt](…)` reference. */
  virtualPath: string;
} & ImageMeta;

/**
 * Options for {@link toMarkdown}. The clean-markdown preset skills use is
 * `{ annotations: "strip", trackedChanges: "clean", comments: "strip",
 * hyperlinks: "inline", footnotes: "strip" }`.
 */
export type MarkdownOptions = {
  /**
   * How to encode constructs markdown can't express natively (comments,
   * tracked changes).
   * - `"html"` (default): emit `<ins>`, `<del>`, `<comment>` tags.
   * - `"pandoc"`: Pandoc-flavoured bracketed spans (`[text]{.ins}`).
   * - `"strip"`: drop the wrapper, keep the visible text.
   */
  annotations?: "html" | "pandoc" | "strip";
  /**
   * Word tracked changes (`w:ins`, `w:del`, `w:moveFrom`, `w:moveTo`).
   * - `"annotate"` (default): preserve via the `annotations` wrapper.
   * - `"clean"`: flatten — insertions become text, deletions vanish.
   */
  trackedChanges?: "clean" | "annotate";
  /**
   * Word margin comments.
   * - `"inline"` (default): wrap the commented text via `annotations`.
   * - `"strip"`: ignore comments entirely.
   * - `"sidecar"`: inline marker + a `## Comments` trailer section.
   */
  comments?: "strip" | "inline" | "sidecar";
  /**
   * Hyperlink rendering.
   * - `"inline"` (default): `[text](https://url)`.
   * - `"reference"`: `[text][N]` + a reference list trailer.
   */
  hyperlinks?: "inline" | "reference";
  /**
   * Footnote/endnote references. Folio addition over upstream #595 (which
   * always emitted `[^N]` markers + a definitions trailer).
   * - `"keep"` (default): `[^N]` markers + a definitions trailer.
   * - `"strip"`: drop footnote markers and their definitions entirely.
   */
  footnotes?: "keep" | "strip";
  /**
   * Receives the {@link ImageMeta} for each image and returns the virtual path
   * placed inside the markdown's `![alt](virtualPath)` reference. Defaults to
   * `./images/{paraId}-img{n}.{ext}` (or `./images/img{n}.{ext}`).
   */
  imagePath?: (info: ImageMeta) => string;
};

/** Result of a render, when the caller needs images/warnings as well as text. */
export type MarkdownResult = {
  /** The full rendered markdown string. */
  markdown: string;
  /** Every image referenced in `markdown`, keyed by its virtual path. */
  images: Map<string, ImageRef>;
  /** Non-fatal diagnostics; recurring messages are deduped. */
  warnings: string[];
};

/** Resolved option values with defaults applied. Used internally. */
export type ResolvedOptions = {
  annotations: "html" | "pandoc" | "strip";
  trackedChanges: "clean" | "annotate";
  comments: "strip" | "inline" | "sidecar";
  hyperlinks: "inline" | "reference";
  footnotes: "keep" | "strip";
  imagePath?: ((info: ImageMeta) => string) | undefined;
};

/**
 * Internal rendering context threaded through every render call. Aggregates
 * side-channel output: image map, warnings, and footnote/comment/hyperlink
 * reference lists. Exported only so the split renderer files share the shape.
 */
export type RenderContext = {
  opts: ResolvedOptions;
  /** Accumulated images keyed by virtual path. */
  images: Map<string, ImageRef>;
  /** Same images keyed by source `MediaFile.path` for dedupe on re-reference. */
  imagesByPath: Map<string, ImageRef>;
  /** Diagnostics accumulator. */
  warnings: string[];
  /** Footnote/endnote refs collected during this render, in document order. */
  footnoteRefs: {
    refId: number;
    markerNumber: number;
    kind: "footnote" | "endnote";
  }[];
  /** Comment refs collected during this render (sidecar mode only). */
  commentRefs: { commentId: number; markerNumber: number }[];
  /** Hyperlink refs collected during this render (reference mode only). */
  hyperlinkRefs: { href: string; refNumber: number }[];
  /** 1-based counter for default virtual paths. */
  imageCounter: number;
  /** Live list counters per numId, for resolving `%N` marker templates. */
  listCounters: Map<number, number[]>;
  /** `numId:level` pairs already seen, so a start override applies once. */
  listSeenLevels: Set<string>;
};
