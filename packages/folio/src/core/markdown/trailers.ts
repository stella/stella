/**
 * Trailer sections appended after the document body: footnote definitions, the
 * hyperlink reference list (`hyperlinks: "reference"`), and the comments
 * sidecar (`comments: "sidecar"`). Split out of `internals` so the renderers
 * can import `pushWarning` without pulling in `renderBlock` (which would form an
 * import cycle). Ported from eigenpal/docx-editor PR #595.
 */

import type {
  Comment,
  Document,
  Endnote,
  Footnote,
  ParagraphContent,
  Run,
} from "../types/document";
import { escapeLinkUrl } from "./escape";
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
        .map(({ href, refNumber }) => `[${refNumber}]: ${escapeLinkUrl(href)}`)
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
    .map((p) => inlineText(p.content))
    .join(" ")
    .trim();
}

function runText(run: Run): string {
  return run.content.map((x) => (x.type === "text" ? x.text : "")).join("");
}

/** Flatten paragraph inline content to plain text, recursing through wrappers. */
function inlineText(content: ParagraphContent[]): string {
  let out = "";
  for (const item of content) {
    if (item.type === "run") {
      out += runText(item);
    } else if (item.type === "hyperlink") {
      for (const child of item.children) {
        if (child.type === "run") {
          out += runText(child);
        }
      }
    } else if (item.type === "simpleField") {
      out += inlineText(item.content);
    } else if (item.type === "complexField") {
      out += inlineText(item.fieldResult);
    } else if (
      item.type === "insertion" ||
      item.type === "deletion" ||
      item.type === "moveFrom" ||
      item.type === "moveTo"
    ) {
      out += inlineText(item.content);
    } else if (item.type === "inlineSdt") {
      out += inlineText(item.content as ParagraphContent[]);
    }
  }
  return out;
}
