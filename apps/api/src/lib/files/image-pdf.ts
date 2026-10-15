import { ops, PDF } from "@libpdf/core";
import { panic } from "better-result";

import type {
  ImageHeader,
  ImageOrientation,
} from "@/api/lib/files/image-header";
import { savePdfRewrite } from "@/api/lib/files/pdf-signatures";

/** Image formats embedded into a PDF directly, without a converter. */
export const EMBEDDABLE_IMAGE_MIME_TYPES = {
  "image/jpeg": null,
  "image/png": null,
} as const satisfies Record<string, null>;

export type EmbeddableImageMimeType = keyof typeof EMBEDDABLE_IMAGE_MIME_TYPES;

export const isEmbeddableImageMimeType = (
  mimeType: string,
): mimeType is EmbeddableImageMimeType =>
  Object.hasOwn(EMBEDDABLE_IMAGE_MIME_TYPES, mimeType);

/**
 * One image pixel in PDF points. Pages are sized as a browser would print the
 * image at CSS resolution (96 px per inch), so a preview keeps the physical
 * size users saw before.
 */
const POINTS_PER_PIXEL = 72 / 96;

type Matrix = readonly [number, number, number, number, number, number];

/**
 * Maps the image's unit square onto a page so the stored pixels appear as
 * EXIF `orientation` says they should be displayed. `width`/`height` are the
 * stored image's size in points; orientations 5-8 swap the page's sides.
 */
export const orientationMatrix = (
  orientation: ImageOrientation,
  width: number,
  height: number,
): Matrix => {
  switch (orientation) {
    case 1: {
      return [width, 0, 0, height, 0, 0];
    }
    case 2: {
      return [-width, 0, 0, height, width, 0];
    }
    case 3: {
      return [-width, 0, 0, -height, width, height];
    }
    case 4: {
      return [width, 0, 0, -height, 0, height];
    }
    case 5: {
      return [0, -width, -height, 0, height, width];
    }
    case 6: {
      return [0, -width, height, 0, 0, width];
    }
    case 7: {
      return [0, width, height, 0, 0, 0];
    }
    case 8: {
      return [0, width, -height, 0, height, 0];
    }
    default: {
      orientation satisfies never;
      return panic(`Unknown image orientation: ${String(orientation)}`);
    }
  }
};

/**
 * A one-page PDF showing the image at its own size. JPEG data is stored
 * as-is (DCTDecode), so a JPEG is never decoded; a PNG is decoded once into
 * its Flate stream. No browser, no base64, no rasterisation.
 */
export const imageToPdf = async ({
  bytes,
  header,
  mimeType,
}: {
  bytes: Uint8Array;
  header: ImageHeader;
  mimeType: EmbeddableImageMimeType;
}): Promise<Uint8Array> => {
  const pdf = PDF.create();
  const image =
    mimeType === "image/jpeg" ? pdf.embedJpeg(bytes) : pdf.embedPng(bytes);
  const width = image.width * POINTS_PER_PIXEL;
  const height = image.height * POINTS_PER_PIXEL;
  const swapsSides = header.orientation >= 5;
  const page = pdf.addPage({
    width: swapsSides ? height : width,
    height: swapsSides ? width : height,
  });
  const name = page.registerImage(image);
  const [a, b, c, d, e, f] = orientationMatrix(
    header.orientation,
    width,
    height,
  );
  page.drawOperators([
    ops.pushGraphicsState(),
    ops.concatMatrix(a, b, c, d, e, f),
    ops.paintXObject(name),
    ops.popGraphicsState(),
  ]);
  const saved = await savePdfRewrite({ pdf, source: new Uint8Array() });
  switch (saved.status) {
    case "saved": {
      return saved.bytes;
    }
    case "signed":
    case "encrypted": {
      return panic("A new image PDF cannot be signed or encrypted");
    }
    default: {
      saved satisfies never;
      return panic("Unknown image PDF save status");
    }
  }
};
