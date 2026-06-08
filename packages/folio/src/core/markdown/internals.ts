/**
 * Internal helpers shared by the markdown converter: context construction and
 * warning dedupe. Kept free of renderer imports so the renderers can import
 * `pushWarning` without forming an import cycle (trailer emission, which needs
 * `renderBlock`, lives in `trailers.ts`). Ported from eigenpal/docx-editor
 * PR #595, trimmed to the sync continuous path.
 */

import type { MarkdownOptions, RenderContext } from "./types";

/**
 * Build a fresh `RenderContext` from caller options, applying defaults. The
 * `footnotes` default is `"keep"` (folio addition over upstream #595).
 */
export function newContext(opts: MarkdownOptions = {}): RenderContext {
  return {
    opts: {
      annotations: opts.annotations ?? "html",
      trackedChanges: opts.trackedChanges ?? "annotate",
      comments: opts.comments ?? "inline",
      hyperlinks: opts.hyperlinks ?? "inline",
      footnotes: opts.footnotes ?? "keep",
      imagePath: opts.imagePath,
    },
    images: new Map(),
    imagesByPath: new Map(),
    warnings: [],
    footnoteRefs: [],
    commentRefs: [],
    hyperlinkRefs: [],
    imageCounter: 0,
  };
}

/**
 * Push a warning into the context, deduplicating against existing entries so
 * recurring messages appear at most once.
 */
export function pushWarning(ctx: RenderContext, message: string): void {
  if (!ctx.warnings.includes(message)) {
    ctx.warnings.push(message);
  }
}
