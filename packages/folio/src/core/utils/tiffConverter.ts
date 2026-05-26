/**
 * TIFF to PNG Converter
 *
 * Browsers don't support TIFF in `<img>` tags, so DOCX-embedded TIFFs are
 * decoded with utif2 and re-encoded as PNG via the Canvas API. Returns
 * null in environments without Canvas (Node.js parsing); callers fall
 * back to the raw TIFF data URL, which won't render in browsers but is
 * fine for headless round-trips.
 */

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

export async function convertTiffToPngDataUrl(
  tiffData: ArrayBuffer,
): Promise<ConvertedTiff | null> {
  // Bail out before any decode if Canvas isn't available — without it we
  // can't produce a PNG anyway, and TIFF decoding + RGBA conversion would
  // allocate hundreds of MB and burn CPU for nothing in headless parses.
  if (
    typeof document === "undefined" ||
    typeof document.createElement !== "function"
  ) {
    return null;
  }

  try {
    const UTIF = await import("utif2");
    const ifds = UTIF.decode(tiffData);
    const firstImage = ifds[0];
    if (!firstImage) {
      return null;
    }

    // `UTIF.decode()` returns IFDs where dimensions are stored as raw
    // tags (`t256` = ImageWidth, `t257` = ImageLength); the `width` /
    // `height` properties on the IFD are populated only after
    // `UTIF.decodeImage()`. Read from the tags so we can enforce the
    // pixel cap BEFORE the eager `toRGBA8` allocation runs.
    const declaredWidth = readTiffTagNumber(firstImage["t256"]);
    const declaredHeight = readTiffTagNumber(firstImage["t257"]);
    if (!declaredWidth || !declaredHeight) {
      return null;
    }
    if (declaredWidth * declaredHeight > MAX_TIFF_PIXELS) {
      return null;
    }

    UTIF.decodeImage(tiffData, firstImage);
    const rgba = UTIF.toRGBA8(firstImage);
    if (rgba.length === 0) {
      return null;
    }

    // Use the post-decodeImage dimensions for the canvas — they may
    // differ from the IFD tags after orientation/strip handling.
    const width = firstImage.width;
    const height = firstImage.height;
    if (!width || !height) {
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

/**
 * Read a numeric TIFF tag value. utif2 stores tag values as arrays
 * (typed or plain), so the cap-check helpers only need the first element.
 */
function readTiffTagNumber(tag: unknown): number | undefined {
  if (typeof tag === "number") {
    return tag;
  }
  if (
    Array.isArray(tag) ||
    tag instanceof Uint8Array ||
    tag instanceof Uint16Array ||
    tag instanceof Uint32Array
  ) {
    const first = tag[0];
    if (typeof first === "number") {
      return first;
    }
  }
  return undefined;
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
