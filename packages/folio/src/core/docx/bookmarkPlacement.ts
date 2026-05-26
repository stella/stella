import type {
  BlockContent,
  BookmarkEnd,
  BookmarkStart,
  Table,
  TableCell,
} from "../types/document";

export type BookmarkMarker = BookmarkStart | BookmarkEnd;

export const appendBookmarkMarkerToLastParagraphInBlocks = (
  blocks: readonly BlockContent[],
  marker: BookmarkMarker,
): boolean => {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block && appendBookmarkMarkerToLastParagraph(block, marker)) {
      return true;
    }
  }
  return false;
};

export const prependBookmarkMarkersToFirstParagraphInBlocks = (
  blocks: readonly BlockContent[],
  markers: readonly BookmarkMarker[],
): boolean => {
  if (markers.length === 0) {
    return true;
  }

  for (const block of blocks) {
    if (prependBookmarkMarkersToFirstParagraph(block, markers)) {
      return true;
    }
  }
  return false;
};

export const appendBookmarkMarkerToLastParagraphInCells = (
  cells: readonly TableCell[],
  marker: BookmarkMarker,
): boolean => {
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    const cell = cells[index];
    if (
      cell &&
      appendBookmarkMarkerToLastParagraphInBlocks(cell.content, marker)
    ) {
      return true;
    }
  }
  return false;
};

export const prependBookmarkMarkersToFirstParagraphInCell = (
  cell: TableCell,
  markers: readonly BookmarkMarker[],
): boolean =>
  prependBookmarkMarkersToFirstParagraphInBlocks(cell.content, markers);

const appendBookmarkMarkerToLastParagraph = (
  block: BlockContent,
  marker: BookmarkMarker,
): boolean => {
  if (block.type === "paragraph") {
    block.content.push(marker);
    return true;
  }

  if (block.type === "table") {
    return appendBookmarkMarkerToLastParagraphInTable(block, marker);
  }

  return appendBookmarkMarkerToLastParagraphInBlocks(block.content, marker);
};

const appendBookmarkMarkerToLastParagraphInTable = (
  table: Table,
  marker: BookmarkMarker,
): boolean => {
  for (let rowIndex = table.rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const row = table.rows[rowIndex];
    if (row && appendBookmarkMarkerToLastParagraphInCells(row.cells, marker)) {
      return true;
    }
  }
  return false;
};

const prependBookmarkMarkersToFirstParagraph = (
  block: BlockContent,
  markers: readonly BookmarkMarker[],
): boolean => {
  if (block.type === "paragraph") {
    block.content.unshift(...markers);
    return true;
  }

  if (block.type === "table") {
    return prependBookmarkMarkersToFirstParagraphInTable(block, markers);
  }

  return prependBookmarkMarkersToFirstParagraphInBlocks(block.content, markers);
};

const prependBookmarkMarkersToFirstParagraphInTable = (
  table: Table,
  markers: readonly BookmarkMarker[],
): boolean => {
  for (const row of table.rows) {
    for (const cell of row.cells) {
      if (prependBookmarkMarkersToFirstParagraphInCell(cell, markers)) {
        return true;
      }
    }
  }
  return false;
};
