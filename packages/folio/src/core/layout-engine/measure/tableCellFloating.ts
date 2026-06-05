import { emuToPixels } from "../../utils/units";
import type { TableCell, TableCellMeasure } from "../types";
import { isFloatingImageRun } from "../types";
import { clampFloatingWrapMargins } from "./clampFloatingWrapMargins";
import type { FloatingImageZone } from "./floatingZones";

export type TableCellFloatingImage = {
  src: string;
  width: number;
  height: number;
  alt?: string;
  transform?: string;
  x: number;
  y: number;
  side: "left" | "right";
  distTop: number;
  distBottom: number;
  distLeft: number;
  distRight: number;
  wrapText?: "bothSides" | "left" | "right" | "largest";
  pmStart?: number;
  pmEnd?: number;
};

export function getTableCellContentWidth(
  cell: TableCell | undefined,
  cellMeasure: TableCellMeasure,
): number {
  const padLeft = cell?.padding?.left ?? 7;
  const padRight = cell?.padding?.right ?? 7;
  return Math.max(0, cellMeasure.width - padLeft - padRight);
}

export function getTableCellFloatingImages(
  cell: TableCell,
  cellMeasure: TableCellMeasure,
  contentWidth: number,
): TableCellFloatingImage[] {
  const result: TableCellFloatingImage[] = [];
  let paragraphY = 0;

  for (let blockIndex = 0; blockIndex < cell.blocks.length; blockIndex++) {
    const block = cell.blocks[blockIndex];
    if (block?.kind !== "paragraph") {
      const blockMeasure = cellMeasure.blocks[blockIndex];
      if (blockMeasure?.kind === "table") {
        paragraphY += blockMeasure.totalHeight;
      }
      continue;
    }

    for (const run of block.runs) {
      if (run.kind !== "image" || !isFloatingImageRun(run)) {
        continue;
      }

      const position = run.position;
      const distTop = run.distTop ?? 0;
      const distBottom = run.distBottom ?? 0;
      const distLeft = run.distLeft ?? 12;
      const distRight = run.distRight ?? 12;

      let side: "left" | "right" = "left";
      let x = 0;
      if (position?.horizontal) {
        const horizontal = position.horizontal;
        if (horizontal.align === "right") {
          side = "right";
          x = contentWidth - run.width;
        } else if (horizontal.align === "left") {
          x = 0;
        } else if (horizontal.align === "center") {
          x = (contentWidth - run.width) / 2;
        } else if (horizontal.posOffset !== undefined) {
          x = emuToPixels(horizontal.posOffset);
          side = x > contentWidth / 2 ? "right" : "left";
        }
      } else if (run.cssFloat === "right") {
        side = "right";
        x = contentWidth - run.width;
      }

      let y = paragraphY;
      if (position?.vertical) {
        const vertical = position.vertical;
        if (vertical.posOffset !== undefined) {
          y = paragraphY + emuToPixels(vertical.posOffset);
        } else if (vertical.align === "top") {
          y = 0;
        }
      }

      x = Math.max(0, Math.min(x, contentWidth - run.width));

      let wrapText: "bothSides" | "left" | "right" | "largest" = "bothSides";
      if (run.cssFloat === "left") {
        wrapText = "right";
      } else if (run.cssFloat === "right") {
        wrapText = "left";
      }

      result.push({
        src: run.src,
        width: run.width,
        height: run.height,
        ...(run.alt !== undefined ? { alt: run.alt } : {}),
        ...(run.transform !== undefined ? { transform: run.transform } : {}),
        x,
        y,
        side,
        distTop,
        distBottom,
        distLeft,
        distRight,
        wrapText,
        ...(run.pmStart !== undefined ? { pmStart: run.pmStart } : {}),
        ...(run.pmEnd !== undefined ? { pmEnd: run.pmEnd } : {}),
      });
    }

    const blockMeasure = cellMeasure.blocks[blockIndex];
    if (blockMeasure?.kind === "paragraph") {
      paragraphY += blockMeasure.totalHeight;
    }
  }

  return result;
}

export function buildTableCellFloatingZones(
  floatingImages: TableCellFloatingImage[],
  contentWidth: number,
): FloatingImageZone[] {
  return floatingImages.map((img) => {
    const rectRight = img.x + img.width + img.distRight;
    const rectTop = img.y - img.distTop;
    const rectBottom = img.y + img.height + img.distBottom;

    let leftMargin = 0;
    let rightMargin = 0;
    const wrapText = img.wrapText ?? "bothSides";
    if (wrapText === "right") {
      leftMargin = rectRight;
    } else if (wrapText === "left") {
      rightMargin = contentWidth - (img.x - img.distLeft);
    } else if (img.side === "left") {
      leftMargin = rectRight;
    } else {
      rightMargin = contentWidth - (img.x - img.distLeft);
    }

    const clamped = clampFloatingWrapMargins(
      leftMargin,
      rightMargin,
      contentWidth,
    );
    return {
      leftMargin: clamped.leftMargin,
      rightMargin: clamped.rightMargin,
      topY: rectTop,
      bottomY: rectBottom,
    };
  });
}
