/**
 * TIFF to PNG Converter
 *
 * Browsers don't support TIFF in `<img>` tags, so DOCX-embedded TIFFs are
 * decoded with utif2 and re-encoded as PNG via the Canvas API. Returns
 * null in environments without Canvas (Node.js parsing); callers fall
 * back to the raw TIFF data URL, which won't render in browsers but is
 * fine for headless round-trips.
 */

import * as UTIF from "utif2";

export function isTiffMimeType(mimeType: string): boolean {
  return mimeType === "image/tiff" || mimeType === "image/tif";
}

export function convertTiffToPngDataUrl(tiffData: ArrayBuffer): string | null {
  try {
    const ifds = UTIF.decode(tiffData);
    const firstImage = ifds[0];
    if (!firstImage) {
      return null;
    }

    UTIF.decodeImage(tiffData, firstImage);
    const rgba = UTIF.toRGBA8(firstImage);

    const width = firstImage.width;
    const height = firstImage.height;
    if (!width || !height || rgba.length === 0) {
      return null;
    }

    if (
      typeof document === "undefined" ||
      typeof document.createElement !== "function"
    ) {
      return null;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }

    const clamped = new Uint8ClampedArray(rgba.length);
    clamped.set(rgba);
    const imageData = new ImageData(clamped, width, height);
    ctx.putImageData(imageData, 0, 0);

    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
