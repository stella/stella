import type { Node as ProseMirrorNode } from "prosemirror-model";

import type { FindMatch } from "../dialogs/findReplaceUtils";

export type FindMatchRange = {
  from: number;
  to: number;
};

export function resolveFindMatchRange(
  doc: ProseMirrorNode,
  match: FindMatch,
): FindMatchRange | null {
  let paragraphIndex = 0;
  let resolved: FindMatchRange | null = null;

  doc.descendants((node, pos) => {
    if (resolved) {
      return false;
    }
    if (node.type.name !== "paragraph") {
      return true;
    }

    if (paragraphIndex !== match.paragraphIndex) {
      paragraphIndex++;
      return false;
    }

    resolved = resolveTextRangeInParagraph({
      paragraph: node,
      paragraphPos: pos,
      startOffset: match.startOffset,
      endOffset: match.endOffset,
    });
    return false;
  });

  return resolved;
}

type ResolveTextRangeInParagraphOptions = {
  paragraph: ProseMirrorNode;
  paragraphPos: number;
  startOffset: number;
  endOffset: number;
};

function resolveTextRangeInParagraph({
  paragraph,
  paragraphPos,
  startOffset,
  endOffset,
}: ResolveTextRangeInParagraphOptions): FindMatchRange | null {
  let textOffset = 0;
  let from: number | null = null;
  let to: number | null = null;

  paragraph.descendants((node, pos) => {
    if (!node.isText) {
      return true;
    }

    const text = node.text ?? "";
    const textStart = textOffset;
    const textEnd = textStart + text.length;

    if (from === null && startOffset >= textStart && startOffset <= textEnd) {
      from = paragraphPos + 1 + pos + (startOffset - textStart);
    }
    if (to === null && endOffset >= textStart && endOffset <= textEnd) {
      to = paragraphPos + 1 + pos + (endOffset - textStart);
    }

    textOffset = textEnd;
    return to === null;
  });

  if (from === null || to === null || from >= to) {
    return null;
  }

  return { from, to };
}
