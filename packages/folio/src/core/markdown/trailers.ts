/**
 * Trailer sections appended after the document body: footnote definitions, the
 * hyperlink reference list (`hyperlinks: "reference"`), and the comments
 * sidecar (`comments: "sidecar"`). Split out of `internals` so the renderers
 * can import `pushWarning` without pulling in `renderBlock` (which would form an
 * import cycle). Ported from eigenpal/docx-editor PR #595.
 */

import type { Comment, Document, Endnote, Footnote } from "../types/document";
import { renderBlocks } from "./renderBlock";
import type { RenderContext } from "./types";

/**
 * Append footnote definitions, the hyperlink reference list (for
 * `hyperlinks: "reference"`), and the comments sidecar block (for
 * `comments: "sidecar"`). Each section is emitted only when its corresponding
 * refs accumulator has entries.
 */
export function appendTrailers(
  ctx: RenderContext,
  doc: Document,
  body: string,
): string {
  const sections: string[] = body.trim() ? [body] : [];

  if (ctx.footnoteRefs.length > 0) {
    const refs = ctx.footnoteRefs.map(({ refId, markerNumber, kind }) => {
      const note =
        kind === "endnote"
          ? doc.package.endnotes?.find((n) => n.id === refId)
          : doc.package.footnotes?.find((f) => f.id === refId);
      return `[^${markerNumber}]: ${note ? noteText(ctx, doc, note) : ""}`;
    });
    sections.push(refs.join("\n"));
  }

  if (ctx.opts.hyperlinks === "reference" && ctx.hyperlinkRefs.length > 0) {
    sections.push(
      ctx.hyperlinkRefs
        .map(({ href, refNumber }) => `[${refNumber}]: ${href}`)
        .join("\n"),
    );
  }

  if (ctx.opts.comments === "sidecar" && ctx.commentRefs.length > 0) {
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

function noteText(
  ctx: RenderContext,
  doc: Document,
  note: Footnote | Endnote,
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
