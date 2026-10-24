import { panic } from "better-result";

import type { ScanPageRotation } from "@stll/scan-engine/types";

import { type PageCleanScan, placeCleanScan } from "./clean-scan-placement";

const imageCanvas = ({ image }: PageCleanScan) => {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  const rgba = context.createImageData(image.width, image.height);
  for (const [index, value] of image.pixels.entries()) {
    const offset = index * 4;
    rgba.data[offset] = value;
    rgba.data[offset + 1] = value;
    rgba.data[offset + 2] = value;
    rgba.data[offset + 3] = 255;
  }
  context.putImageData(rgba, 0, 0);
  return canvas;
};

/** Canvas setup that maps unrotated page points (top-left origin) onto the displayed page. */
const rotatePage = (
  context: CanvasRenderingContext2D,
  rotation: ScanPageRotation,
  { height, width }: { height: number; width: number },
) => {
  switch (rotation) {
    case 0:
      return;
    case 90:
      context.translate(width, 0);
      context.rotate(Math.PI / 2);
      return;
    case 180:
      context.translate(width, height);
      context.rotate(Math.PI);
      return;
    case 270:
      context.translate(0, height);
      context.rotate(-Math.PI / 2);
      return;
    default: {
      rotation satisfies never;
      panic(`Unhandled rotation: ${String(rotation)}`);
    }
  }
};

type DrawCleanScanPageOptions = {
  canvas: HTMLCanvasElement;
  rotation: ScanPageRotation;
  scan: PageCleanScan;
  /** Width of the drawn page in device pixels. */
  widthPx: number;
};

/**
 * Draw a cleaned page as the page transform emits it: the image placed by
 * {@link placeCleanScan} on a white page of the source page's size, turned
 * by the page's rotation. Previews and thumbnails share this, so what the
 * user reviews is what the saved PDF contains.
 */
export const drawCleanScanPage = ({
  canvas,
  rotation,
  scan,
  widthPx,
}: DrawCleanScanPageOptions): void => {
  const { box, image } = placeCleanScan(scan, rotation);
  const quarterTurn = rotation === 90 || rotation === 270;
  const displayWidth = quarterTurn ? box.heightPoints : box.widthPoints;
  const displayHeight = quarterTurn ? box.widthPoints : box.heightPoints;
  const scale = widthPx / displayWidth;
  canvas.width = Math.max(1, Math.round(widthPx));
  canvas.height = Math.max(1, Math.round(displayHeight * scale));
  const context = canvas.getContext("2d");
  const source = imageCanvas(scan);
  if (!context || !source) {
    return;
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  rotatePage(context, rotation, canvas);
  context.scale(scale, scale);
  context.drawImage(
    source,
    image.x,
    box.heightPoints - image.y - image.height,
    image.width,
    image.height,
  );
  context.restore();
  source.width = 0;
  source.height = 0;
};
