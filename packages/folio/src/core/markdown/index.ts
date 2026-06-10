/**
 * DOCX-document → Markdown converter. Ported from eigenpal/docx-editor PR #595,
 * scoped to the synchronous, continuous (non-paged) `Document → string` path
 * that the skills bridge needs. The upstream paged + async + image-handler
 * variants are intentionally not ported (skill bodies have no images today);
 * they can be added later from the same branch.
 *
 * The clean-markdown preset for an AI-facing skill body is:
 *
 * ```ts
 * toMarkdown(doc, {
 *   annotations: "strip",
 *   trackedChanges: "clean",
 *   comments: "strip",
 *   hyperlinks: "inline",
 *   footnotes: "strip",
 * });
 * ```
 *
 * GFM tables are emitted automatically (simple tables → pipe tables; merged or
 * nested cells → inline HTML `<table>`). Headers/footers never appear: they
 * live outside `document.content`, which is the only block stream walked here.
 */

import type { Document } from "../types/document";
import { newContext } from "./internals";
import { renderBlocks } from "./renderBlock";
import { appendTrailers } from "./trailers";
import type { MarkdownOptions, MarkdownResult } from "./types";

export type {
  ImageMeta,
  ImageRef,
  MarkdownOptions,
  MarkdownResult,
} from "./types";

// Markdown → Document import — the inverse of toMarkdown (the skills bridge's
// second half).
export { fromMarkdown } from "./fromMarkdown";

/**
 * Convert a parsed `Document` to a markdown string. Synchronous; pre-parse the
 * DOCX (e.g. via the editor or `parseDocx`) before calling.
 */
export function toMarkdown(doc: Document, opts?: MarkdownOptions): string {
  return renderDocument(doc, opts).markdown;
}

/**
 * Like {@link toMarkdown}, but also returns the registered images and any
 * non-fatal warnings. Use when post-processing image bytes or surfacing
 * diagnostics; skill bodies only need {@link toMarkdown}.
 */
export function toMarkdownResult(
  doc: Document,
  opts?: MarkdownOptions,
): MarkdownResult {
  return renderDocument(doc, opts);
}

function renderDocument(
  doc: Document,
  opts: MarkdownOptions = {},
): MarkdownResult {
  const ctx = newContext(opts);
  const body = renderBlocks(ctx, doc.package, doc.package.document.content);
  const markdown = appendTrailers(ctx, doc, body);
  if (doc.warnings) {
    ctx.warnings.unshift(...doc.warnings);
  }
  if (!markdown.trim()) {
    ctx.warnings.push("document has no content");
  }
  return { markdown, images: ctx.images, warnings: ctx.warnings };
}
