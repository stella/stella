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

  const visitParagraph = (node: ProseMirrorNode, pos: number): boolean => {
    if (resolved) {
      return false;
    }
    if (paragraphIndex !== match.paragraphIndex) {
      paragraphIndex++;
      return true;
    }

    resolved = resolveTextRangeInParagraph({
      paragraph: node,
      paragraphPos: pos,
      startOffset: match.startOffset,
      endOffset: match.endOffset,
    });
    return false;
  };

  const walkBlocks = (
    container: ProseMirrorNode,
    contentStart: number,
  ): boolean => {
    let offset = 0;
    for (let childIndex = 0; childIndex < container.childCount; childIndex++) {
      const child = container.child(childIndex);
      const childPos = contentStart + offset;
      if (child.type.name === "paragraph") {
        if (!visitParagraph(child, childPos)) {
          return false;
        }
      } else if (child.type.name === "table" && !walkTable(child, childPos)) {
        return false;
      }

      offset += child.nodeSize;
    }
    return true;
  };

  const walkTable = (table: ProseMirrorNode, tablePos: number): boolean => {
    let rowOffset = 0;
    for (let rowIndex = 0; rowIndex < table.childCount; rowIndex++) {
      const row = table.child(rowIndex);
      if (row.type.name !== "tableRow") {
        rowOffset += row.nodeSize;
        continue;
      }

      const rowPos = tablePos + 1 + rowOffset;
      let cellOffset = 0;
      for (let cellIndex = 0; cellIndex < row.childCount; cellIndex++) {
        const cell = row.child(cellIndex);
        if (
          cell.type.name !== "tableCell" &&
          cell.type.name !== "tableHeader"
        ) {
          cellOffset += cell.nodeSize;
          continue;
        }

        const cellPos = rowPos + 1 + cellOffset;
        if (!walkBlocks(cell, cellPos + 1)) {
          return false;
        }
        cellOffset += cell.nodeSize;
      }

      rowOffset += row.nodeSize;
    }
    return true;
  };

  walkBlocks(doc, 0);

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
  const range = { from: null as number | null, to: null as number | null };

  paragraph.descendants((node, pos) => {
    const tokenLength = getSearchTextTokenLength(node);
    if (tokenLength === 0) {
      return true;
    }

    const textStart = textOffset;
    const textEnd = textStart + tokenLength;
    const nodeStart = paragraphPos + 1 + pos;

    if (
      range.from === null &&
      startOffset >= textStart &&
      startOffset <= textEnd
    ) {
      range.from = nodeStart + Math.min(startOffset - textStart, node.nodeSize);
    }
    if (range.to === null && endOffset >= textStart && endOffset <= textEnd) {
      range.to = nodeStart + Math.min(endOffset - textStart, node.nodeSize);
    }

    textOffset = textEnd;
    return range.to === null;
  });

  if (range.from === null || range.to === null || range.from >= range.to) {
    return null;
  }

  return { from: range.from, to: range.to };
}

function getSearchTextTokenLength(node: ProseMirrorNode): number {
  if (node.isText) {
    return node.text?.length ?? 0;
  }

  if (node.type.name === "tab" || node.type.name === "hardBreak") {
    return 1;
  }

  return 0;
}
