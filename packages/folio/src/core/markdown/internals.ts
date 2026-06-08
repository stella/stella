/**
 * Internal helpers shared by the markdown converter: context construction,
 * warning dedupe, and trailer (footnote / hyperlink-reference / comment
 * sidecar) emission. Ported from eigenpal/docx-editor PR #595, trimmed to the
 * sync continuous path (no byte-input narrowing, no paged header/footer).
 */

import type { Comment, Document, Footnote } from "../types/document";
import { renderBlocks } from "./renderBlock";
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

/**
 * Append footnote definitions, the hyperlink reference list (for
 * `hyperlinks: "reference"`), and the comments sidecar block (for
 * `comments: "sidecar"`) to the rendered body. Each section is emitted only
 * when its corresponding refs accumulator has entries.
 */
export function appendTrailers(
  ctx: RenderContext,
  doc: Document,
  body: string,
): string {
  const sections: string[] = body.trim() ? [body] : [];

  if (ctx.footnoteRefs.length) {
    const refs = ctx.footnoteRefs.map(({ refId, markerNumber }) => {
      const note = doc.package.footnotes?.find((f) => f.id === refId);
      return `[^${markerNumber}]: ${note ? footnoteText(ctx, doc, note) : ""}`;
    });
    sections.push(refs.join("\n"));
  }

  if (ctx.opts.hyperlinks === "reference" && ctx.hyperlinkRefs.length) {
    sections.push(
      ctx.hyperlinkRefs
        .map(({ href, refNumber }) => `[${refNumber}]: ${href}`)
        .join("\n"),
    );
  }

  if (ctx.opts.comments === "sidecar" && ctx.commentRefs.length) {
    const lines: string[] = ["## Comments"];
    for (const { commentId, markerNumber } of ctx.commentRefs) {
      const c = doc.package.document.comments?.find(
        (cm) => cm.id === commentId,
      );
      const author = c?.author ? `${c.author}: ` : "";
      const text = c ? commentText(c) : "";
      lines.push(`[^c${markerNumber}]: ${author}${text}`);
    }
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

function footnoteText(
  ctx: RenderContext,
  doc: Document,
  note: Footnote,
): string {
  return renderBlocks(ctx, doc.package, note.content)
    .replace(/\n+/gu, " ")
    .trim();
}

function commentText(comment: Comment): string {
  return comment.content
    .map((p) =>
      p.content
        .map((c) =>
          c.type === "run"
            ? c.content.map((x) => (x.type === "text" ? x.text : "")).join("")
            : "",
        )
        .join(""),
    )
    .join(" ")
    .trim();
}
