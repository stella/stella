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

/**
 * Hard cap on the pixel count we'll attempt to decode. Each pixel costs 4 B
 * for the intermediate RGBA buffer plus another canvas-managed bitmap, so
 * 64 MP ≈ 256 MB before counting the PNG re-encode. A crafted TIFF whose
 * declared dimensions exceed this is rejected without allocating the
 * RGBA buffer, which would otherwise hang or OOM the tab.
 */
const MAX_TIFF_PIXELS = 64_000_000;

export function isTiffMimeType(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  return lower === "image/tiff" || lower === "image/tif";
}

export type ConvertedTiff = {
  dataUrl: string;
  data: ArrayBuffer;
};

export function convertTiffToPngDataUrl(
  tiffData: ArrayBuffer,
): ConvertedTiff | null {
  try {
    const ifds = UTIF.decode(tiffData);
    const firstImage = ifds[0];
    if (!firstImage) {
      return null;
    }

    // Validate dimensions BEFORE the eager RGBA allocation.
    const width = firstImage.width;
    const height = firstImage.height;
    if (!width || !height) {
      return null;
    }
    if (width * height > MAX_TIFF_PIXELS) {
      return null;
    }

    UTIF.decodeImage(tiffData, firstImage);
    const rgba = UTIF.toRGBA8(firstImage);
    if (rgba.length === 0) {
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

    const dataUrl = canvas.toDataURL("image/png");
    const data = dataUrlToArrayBuffer(dataUrl);
    if (!data) {
      return null;
    }
    return { dataUrl, data };
  } catch {
    return null;
  }
}

function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer | null {
  const base64 = dataUrl.split(",", 2)[1];
  if (!base64) {
    return null;
  }
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.codePointAt(i) ?? 0;
    }
    return bytes.buffer;
  } catch {
    return null;
  }
}
