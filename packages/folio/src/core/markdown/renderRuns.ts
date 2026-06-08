/**
 * Render inline content (runs, hyperlinks, comment-range markers, tracked
 * changes) to markdown. Operates on the `ParagraphContent[]` of a paragraph, or
 * the equivalent inline lists inside hyperlinks and tracked-change wrappers.
 *
 * Inline marks are rendered as character-precise wrappers around the affected
 * runs. Comments and tracked changes become configurable annotation tags via
 * `./annotations`. Ported from eigenpal/docx-editor PR #595 (folio adds the
 * `footnotes: "strip"` gate).
 */

import type {
  Comment,
  CommentRangeEnd,
  CommentRangeStart,
  Deletion,
  DocxPackage,
  Hyperlink,
  Insertion,
  MoveFrom,
  MoveTo,
  ParagraphContent,
  Run,
  RunContent,
} from "../types/document";
import {
  wrapComment,
  wrapDeletion,
  wrapInsertion,
  wrapMoveFrom,
  wrapMoveTo,
} from "./annotations";
import { escapeAltText, escapeInline, escapeLinkUrl } from "./escape";
import { registerImage } from "./images";
import { pushWarning } from "./internals";
import type { RenderContext } from "./types";

/**
 * Inline marks we recognize. Order matters: we open from outermost to innermost
 * so the output reads cleanly (`***bold italic***`), not the reverse.
 */
type MarkKey = "bold" | "italic" | "code" | "strike";

const MARK_DELIMS: Record<MarkKey, string> = {
  bold: "**",
  italic: "*",
  code: "`",
  strike: "~~",
};

// Word has no `code` run property. We infer it from a small whitelist of
// monospace font families so prose set in fonts like `Monotype Corsiva` is not
// wrapped in backticks.
const MONOSPACE_FONTS = new Set([
  "consolas",
  "courier",
  "courier new",
  "menlo",
  "monaco",
  "sf mono",
  "jetbrains mono",
  "fira code",
  "fira mono",
  "source code pro",
  "roboto mono",
  "inconsolata",
  "lucida console",
  "monospace",
]);

function marksFor(run: Run): MarkKey[] {
  const f = run.formatting;
  if (!f) {
    return [];
  }
  const out: MarkKey[] = [];
  if (f.bold) {
    out.push("bold");
  }
  if (f.italic) {
    out.push("italic");
  }
  if (f.strike) {
    out.push("strike");
  }
  const ascii = f.fontFamily?.ascii?.toLowerCase();
  if (ascii && MONOSPACE_FONTS.has(ascii)) {
    out.push("code");
  }
  return out;
}

function applyMarks(text: string, marks: MarkKey[]): string {
  if (!text) {
    return text;
  }
  // Code overrides other marks: code is literal.
  if (marks.includes("code")) {
    // If text contains backticks, use a longer fence.
    if (text.includes("`")) {
      return `\`\`${text}\`\``;
    }
    return `\`${text}\``;
  }
  let out = text;
  for (const m of marks) {
    const d = MARK_DELIMS[m];
    out = `${d}${out}${d}`;
  }
  return out;
}

/** Render a single run's RunContent array into the inline text fragment. */
function renderRunContent(
  ctx: RenderContext,
  pkg: DocxPackage | undefined,
  content: RunContent[],
  paraId: string | undefined,
): string {
  let out = "";
  for (const item of content) {
    switch (item.type) {
      case "text":
        out += escapeInline(item.text);
        break;
      case "tab":
        out += "    ";
        break;
      case "break":
        if (item.breakType === "page") {
          // Page break inside text; in unpaged output we emit a paragraph break.
          out += "\n\n";
        } else {
          // Soft break: markdown's two-space hard wrap.
          out += "  \n";
        }
        break;
      case "symbol":
        out += escapeInline(item.char);
        break;
      case "softHyphen":
        // U+00AD soft hyphen. Word displays it only when needed for line
        // breaks; drop it from the markdown output.
        break;
      case "noBreakHyphen":
        out += "‑";
        break;
      case "footnoteRef":
      case "endnoteRef": {
        if (ctx.opts.footnotes === "strip") {
          break;
        }
        const markerNumber = ctx.footnoteRefs.length + 1;
        ctx.footnoteRefs.push({
          refId: item.id,
          markerNumber,
          kind: item.type === "endnoteRef" ? "endnote" : "footnote",
        });
        out += `[^${markerNumber}]`;
        break;
      }
      case "drawing": {
        // Preferred path: resolve via the package's rels → media chain. That
        // returns raw bytes, so we register a stable virtual path and expose
        // the image in `result.images`.
        const ref = pkg?.relationships?.get(item.image.rId);
        const media = ref ? pkg?.media?.get(ref.target) : undefined;
        if (media) {
          const reg = registerImage(ctx, media, item.image, paraId);
          const alt = reg.alt ? escapeAltText(reg.alt) : "";
          out += `![${alt}](${reg.virtualPath})`;
          break;
        }
        // Fallback: header/footer images use a separate rels file that does not
        // live in `pkg.relationships`. The parser inlines the bytes into
        // `image.src` (typically a data URL) — emit that directly.
        if (item.image.src) {
          const alt =
            item.image.alt ?? item.image.title ?? item.image.filename ?? "";
          out += `![${escapeAltText(alt)}](${item.image.src})`;
          break;
        }
        pushWarning(ctx, `image rId=${item.image.rId} not resolvable`);
        break;
      }
      case "shape":
        pushWarning(ctx, "shape not representable in markdown");
        break;
      case "fieldChar":
      case "instrText":
        // Field chrome. Skip: the field result text lives in surrounding runs.
        break;
      default:
        break;
    }
  }
  return out;
}

/** Render a single Run with its formatting applied. */
function renderRun(
  ctx: RenderContext,
  pkg: DocxPackage | undefined,
  run: Run,
  paraId: string | undefined,
): string {
  const inner = renderRunContent(ctx, pkg, run.content, paraId);
  if (!inner) {
    return "";
  }
  // Markdown can't carry whitespace at the boundaries of a mark, so we split
  // leading/trailing whitespace out of the wrapped text. Done with trim-length
  // math rather than a regex to avoid backtracking on long runs.
  const leadLen = inner.length - inner.trimStart().length;
  const trailLen = inner.length - inner.trimEnd().length;
  const core = inner.slice(leadLen, inner.length - trailLen);
  if (!core) {
    return inner;
  }
  const lead = inner.slice(0, leadLen);
  const trail = inner.slice(inner.length - trailLen);
  return `${lead}${applyMarks(core, marksFor(run))}${trail}`;
}

function renderHyperlink(
  ctx: RenderContext,
  pkg: DocxPackage | undefined,
  link: Hyperlink,
  paraId: string | undefined,
): string {
  const inner = link.children
    .map((child) =>
      child.type === "run" ? renderRun(ctx, pkg, child, paraId) : "",
    )
    .join("");
  if (!inner) {
    return "";
  }
  const href = link.href ?? (link.anchor ? `#${link.anchor}` : "");
  if (!href) {
    pushWarning(
      ctx,
      "hyperlink missing href and anchor; rendered as plain text",
    );
    return inner;
  }
  if (ctx.opts.hyperlinks === "reference") {
    const refNumber = ctx.hyperlinkRefs.length + 1;
    ctx.hyperlinkRefs.push({ href, refNumber });
    return `[${inner}][${refNumber}]`;
  }
  return `[${inner}](${escapeLinkUrl(href)})`;
}

function renderTrackedWrapper(
  ctx: RenderContext,
  pkg: DocxPackage | undefined,
  wrapper: Insertion | Deletion | MoveFrom | MoveTo,
  paraId: string | undefined,
): string {
  if (ctx.opts.trackedChanges === "clean") {
    // Insertions become real text; deletions vanish.
    if (wrapper.type === "insertion" || wrapper.type === "moveTo") {
      return wrapper.content
        .map((child) =>
          child.type === "run"
            ? renderRun(ctx, pkg, child, paraId)
            : renderHyperlink(ctx, pkg, child, paraId),
        )
        .join("");
    }
    return "";
  }
  const inner = wrapper.content
    .map((child) =>
      child.type === "run"
        ? renderRun(ctx, pkg, child, paraId)
        : renderHyperlink(ctx, pkg, child, paraId),
    )
    .join("");
  switch (wrapper.type) {
    case "insertion":
      return wrapInsertion(ctx, wrapper.info, inner);
    case "deletion":
      return wrapDeletion(ctx, wrapper.info, inner);
    case "moveFrom":
      return wrapMoveFrom(ctx, wrapper.info, inner);
    default:
      return wrapMoveTo(ctx, wrapper.info, inner);
  }
}

type CommentSlot = {
  start: number;
  comment?: Comment | undefined;
};

/**
 * Render the full inline content of a paragraph, tracking comment-range
 * boundaries to apply the configured wrapper.
 */
export function renderParagraphInline(
  ctx: RenderContext,
  pkg: DocxPackage | undefined,
  content: ParagraphContent[],
  paraId: string | undefined,
): string {
  let out = "";
  // Stack of open comment ranges (document order) so nested comments wrap right.
  const openComments: CommentSlot[] = [];

  for (const item of content) {
    switch (item.type) {
      case "run":
        out += renderRun(ctx, pkg, item, paraId);
        break;
      case "hyperlink":
        out += renderHyperlink(ctx, pkg, item, paraId);
        break;
      case "insertion":
      case "deletion":
      case "moveFrom":
      case "moveTo":
        out += renderTrackedWrapper(ctx, pkg, item, paraId);
        break;
      case "commentRangeStart":
        out += handleCommentStart(ctx, pkg, item, openComments, out.length);
        break;
      case "commentRangeEnd":
        out = handleCommentEnd(ctx, item, openComments, out);
        break;
      case "commentReference":
        // A point comment (or a range the parser collapsed to a reference).
        // It has no covered text, so emit just the marker.
        out += renderPointComment(ctx, pkg, item.id);
        break;
      case "simpleField":
      case "complexField": {
        // Render the visible result content.
        const runs =
          item.type === "simpleField" ? item.content : item.fieldResult;
        for (const child of runs) {
          out +=
            child.type === "run"
              ? renderRun(ctx, pkg, child, paraId)
              : renderHyperlink(ctx, pkg, child, paraId);
        }
        break;
      }
      case "inlineSdt":
        // `InlineSdt.content` is a subset of `ParagraphContent`.
        out += renderParagraphInline(
          ctx,
          pkg,
          item.content as ParagraphContent[],
          paraId,
        );
        break;
      default:
        // Range markers without inline payload (bookmark*, move*Range*,
        // commentReference, math) contribute nothing here.
        break;
    }
  }

  // Close any still-open comment ranges defensively.
  while (openComments.length) {
    const slot = openComments.pop();
    if (!slot) {
      break;
    }
    if (!slot.comment || ctx.opts.comments === "strip") {
      continue;
    }
    out = applyCommentWrapping(ctx, slot, out);
  }

  return out;
}

function handleCommentStart(
  ctx: RenderContext,
  pkg: DocxPackage | undefined,
  marker: CommentRangeStart,
  openComments: CommentSlot[],
  startPos: number,
): string {
  if (ctx.opts.comments === "strip") {
    openComments.push({ start: startPos, comment: undefined });
    return "";
  }
  const comment = pkg?.document.comments?.find((c) => c.id === marker.id);
  openComments.push({ start: startPos, comment });
  return "";
}

function renderPointComment(
  ctx: RenderContext,
  pkg: DocxPackage | undefined,
  id: number,
): string {
  if (ctx.opts.comments === "strip") {
    return "";
  }
  const comment = pkg?.document.comments?.find((c) => c.id === id);
  if (!comment) {
    return "";
  }
  if (ctx.opts.comments === "sidecar") {
    const markerNumber = ctx.commentRefs.length + 1;
    ctx.commentRefs.push({ commentId: comment.id, markerNumber });
    return `[^c${markerNumber}]`;
  }
  // Inline: a point comment covers no text, so wrap an empty span.
  return wrapComment(ctx, { id: comment.id, author: comment.author }, "");
}

function handleCommentEnd(
  ctx: RenderContext,
  _marker: CommentRangeEnd,
  openComments: CommentSlot[],
  current: string,
): string {
  const slot = openComments.pop();
  if (!slot || !slot.comment || ctx.opts.comments === "strip") {
    return current;
  }
  return applyCommentWrapping(ctx, slot, current);
}

function applyCommentWrapping(
  ctx: RenderContext,
  slot: CommentSlot,
  current: string,
): string {
  if (!slot.comment) {
    return current;
  }
  const before = current.slice(0, slot.start);
  const inner = current.slice(slot.start);
  if (ctx.opts.comments === "sidecar") {
    const markerNumber = ctx.commentRefs.length + 1;
    ctx.commentRefs.push({ commentId: slot.comment.id, markerNumber });
    return `${before}${inner}[^c${markerNumber}]`;
  }
  return (
    before +
    wrapComment(
      ctx,
      { id: slot.comment.id, author: slot.comment.author },
      inner,
    )
  );
}
